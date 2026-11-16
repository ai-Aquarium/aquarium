"""FG-03 P2 — the box-level source registry: one owner per incoming source.

A *source* is one incoming account: a mailbox, a WhatsApp number or a Telegram
bot. Each has exactly **one** Aquarium owner (a GoTrue user id). A second user
claiming the same address/number/bot is refused, and the refusal is recorded as
a claim conflict the box owner can resolve. The owner chooses which of *their*
user-profiles (profiles where they hold an active ``principals`` row) the
source routes to; a profile with no enabled route never reads the source.

The list is box-wide, so it cannot live in any profile's ``app_prod[_<slug>]``
schema: CMO's agent cannot read CFO's schema, and the FG-27 ownership guard
refuses foreign schemas by design. It lives in the dedicated schema
:data:`BOX_SCHEMA` in the same Postgres. Its name does not start with ``app_``,
so no profile slug can derive it, and its marker table is ``box_marker``
(not ``schema_owner``), so :func:`hermes_cli.datastore.verify_schema_owner`
and :func:`~hermes_cli.datastore.claim_schema_owner` never claim it.
``hermes db migrate`` creates it (see :func:`hermes_cli.db_migrate.migrate_box`);
:func:`connect_box` opens a connection pinned to it.

``credential_ref`` is a *pointer* to where the secret lives (for example
``{"profile": "default", "kind": "email-imap", "name": "john@example.com"}``),
never the secret itself: :func:`register_source` refuses keys that look like
secrets.

Every function takes an open connection whose ``search_path`` is
:data:`BOX_SCHEMA` (from :func:`connect_box`); SQL is still schema-qualified so
the same functions are safe on any connection to the database.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping, Optional, Sequence

if TYPE_CHECKING:
    import asyncpg

logger = logging.getLogger(__name__)

#: The box-wide schema. Never ``app_*``: profile schemas are ``app_prod`` /
#: ``app_prod_<slug>`` / ``app_dev*``, so no profile can collide with it.
BOX_SCHEMA = "aquarium_box"
#: The value of ``box_marker.kind``; a schema whose marker says otherwise is refused.
BOX_MARKER_KIND = "aquarium_box"

CHANNELS: tuple[str, ...] = ("email", "whatsapp", "telegram")

#: ``credential_ref`` must point at a secret, not carry one.
_SECRET_KEYS = re.compile(r"pass|secret|token|key|cookie|session", re.IGNORECASE)
_ALLOWED_REF_KEYS = frozenset({"profile", "kind", "name", "provider", "owner_user_id", "bridge", "port"})
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PROFILE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

DDL = f"""
CREATE SCHEMA IF NOT EXISTS {BOX_SCHEMA};

CREATE TABLE IF NOT EXISTS {BOX_SCHEMA}.box_marker (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {BOX_SCHEMA}.sources (
    source_id UUID PRIMARY KEY,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'telegram')),
    address TEXT NOT NULL CHECK (address <> ''),
    owner_user_id TEXT NOT NULL CHECK (owner_user_id <> ''),
    display TEXT,
    credential_ref JSONB,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (channel, address)
);
CREATE INDEX IF NOT EXISTS sources_owner_idx
    ON {BOX_SCHEMA}.sources (owner_user_id);

CREATE TABLE IF NOT EXISTS {BOX_SCHEMA}.source_routes (
    source_id UUID NOT NULL
        REFERENCES {BOX_SCHEMA}.sources(source_id) ON DELETE CASCADE,
    profile_slug TEXT NOT NULL CHECK (profile_slug <> ''),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_id, profile_slug)
);
CREATE INDEX IF NOT EXISTS source_routes_profile_idx
    ON {BOX_SCHEMA}.source_routes (profile_slug);

CREATE TABLE IF NOT EXISTS {BOX_SCHEMA}.source_claim_conflicts (
    conflict_id BIGSERIAL PRIMARY KEY,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    claimant_user_id TEXT NOT NULL,
    existing_owner_user_id TEXT,
    detail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS source_claim_conflicts_open_idx
    ON {BOX_SCHEMA}.source_claim_conflicts (channel, address, claimant_user_id)
    WHERE resolved_at IS NULL;
"""


# -- errors -----------------------------------------------------------------


class SourceRegistryError(RuntimeError):
    """Base error; ``status`` is the HTTP status the API maps it to."""

    status = 400


class SourceOwnedByAnotherUser(SourceRegistryError):
    """The address is already registered to a different user.

    The message deliberately names nobody: who owns somebody else's mailbox is
    not the claimant's business.
    """

    status = 409

    def __init__(self, channel: str, address: str) -> None:
        super().__init__(
            f"This {channel} source ({address}) is already registered to another "
            "user. Ask the box owner if you think it should be yours."
        )
        self.channel = channel
        self.address = address


class SourceNotFound(SourceRegistryError):
    status = 404


class SourcePermissionError(SourceRegistryError):
    """The actor may not change this source (not its owner / not box admin)."""

    status = 403


class ProfileNotEnrolled(SourceRegistryError):
    """The owner is not an active member of the profile they tried to route to."""

    status = 403


class BoxSchemaError(SourceRegistryError):
    """The box schema is missing, or is claimed by something else."""

    status = 503


# -- records ----------------------------------------------------------------


@dataclass(frozen=True)
class Route:
    """One source → user-profile route. The route's user is always the source owner."""

    source_id: str
    profile_slug: str
    enabled: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "profile": self.profile_slug,
            "enabled": self.enabled,
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }


@dataclass(frozen=True)
class Source:
    """One incoming account with its single owner and its routes."""

    source_id: str
    channel: str
    address: str
    owner_user_id: str
    display: Optional[str] = None
    credential_ref: Optional[dict[str, Any]] = None
    enabled: bool = True
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    routes: tuple[Route, ...] = field(default_factory=tuple)

    def routed_profiles(self) -> list[str]:
        """Profiles with an enabled route (the source itself must be enabled)."""
        if not self.enabled:
            return []
        return [r.profile_slug for r in self.routes if r.enabled]

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "channel": self.channel,
            "address": self.address,
            "owner_user_id": self.owner_user_id,
            "display": self.display,
            "credential_ref": self.credential_ref,
            "enabled": self.enabled,
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
            "routes": [r.as_dict() for r in self.routes],
        }


@dataclass(frozen=True)
class ClaimConflict:
    """A refused or disputed claim on a source, kept until the box owner resolves it."""

    conflict_id: int
    channel: str
    address: str
    claimant_user_id: str
    existing_owner_user_id: Optional[str]
    detail: str
    created_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "conflict_id": self.conflict_id,
            "channel": self.channel,
            "address": self.address,
            "claimant_user_id": self.claimant_user_id,
            "existing_owner_user_id": self.existing_owner_user_id,
            "detail": self.detail,
            "created_at": _iso(self.created_at),
            "resolved_at": _iso(self.resolved_at),
        }


#: ``(user_id, profile) -> active member?``; injectable for tests and callers
#: that already know. The default reads that profile's own ``principals``.
MembershipCheck = Callable[[str, str], Awaitable[bool]]
#: ``user_id -> box owner/admin?``
BoxAdminCheck = Callable[[str], Awaitable[bool]]


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


# -- normalisation ----------------------------------------------------------


def normalize_channel(channel: str) -> str:
    value = str(channel or "").strip().lower()
    if value not in CHANNELS:
        raise SourceRegistryError(
            f"Unknown channel {channel!r}; expected one of {', '.join(CHANNELS)}."
        )
    return value


def normalize_address(channel: str, raw: str) -> str:
    """The canonical address for ``channel``, used as the uniqueness key.

    - ``email``: trimmed and lowercased (``John@Example.com`` →
      ``john@example.com``); a ``mailto:`` prefix and ``<...>`` are dropped.
    - ``whatsapp``: E.164 digits only, no ``+`` (``+852 9123-4567`` →
      ``85291234567``); a JID (``85291234567@s.whatsapp.net``) or a
      ``whatsapp:`` prefix is accepted. A leading ``00`` is the international
      prefix and is dropped.
    - ``telegram``: the numeric bot id. A bot token ``<id>:<secret>`` is
      accepted and reduced to the id (the secret part is never kept).
    """
    channel = normalize_channel(channel)
    value = str(raw or "").strip()
    if channel == "email":
        value = value.removeprefix("mailto:").strip().strip("<>").strip().lower()
        if not _EMAIL.fullmatch(value):
            raise SourceRegistryError(f"Not an email address: {raw!r}")
        return value
    if channel == "whatsapp":
        value = value.removeprefix("whatsapp:")
        value = value.split("@", 1)[0].split(":", 1)[0]
        digits = re.sub(r"[\s\-().+]", "", value)
        if digits.startswith("00"):
            digits = digits[2:]
        if not digits.isdigit() or not 7 <= len(digits) <= 15:
            raise SourceRegistryError(
                f"Not a WhatsApp number in international format: {raw!r}"
            )
        return digits
    value = value.removeprefix("tgbot:").removeprefix("telegram:")
    bot_id = value.split(":", 1)[0].strip()
    if not bot_id.isdigit():
        raise SourceRegistryError(f"Not a numeric Telegram bot id: {raw!r}")
    return str(int(bot_id))


def _check_credential_ref(ref: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    if ref is None:
        return None
    if not isinstance(ref, Mapping):
        raise SourceRegistryError("credential_ref must be an object")
    out: dict[str, Any] = {}
    for key, value in ref.items():
        key = str(key)
        if key not in _ALLOWED_REF_KEYS or _SECRET_KEYS.search(key) and key != "kind":
            raise SourceRegistryError(
                f"credential_ref may only point at a credential "
                f"({', '.join(sorted(_ALLOWED_REF_KEYS))}); {key!r} is not allowed"
            )
        if not isinstance(value, (str, int)) or isinstance(value, bool):
            raise SourceRegistryError(f"credential_ref.{key} must be a string or number")
        out[key] = value
    return out


def _check_profile(profile_slug: str) -> str:
    value = str(profile_slug or "").strip().lower()
    if not _PROFILE_NAME.fullmatch(value):
        raise SourceRegistryError(f"Invalid profile name: {profile_slug!r}")
    return value


def _check_user(user_id: str, what: str = "user id") -> str:
    value = str(user_id or "").strip()
    if not value:
        raise SourceRegistryError(f"A {what} is required")
    return value


# -- schema + connection ----------------------------------------------------


async def initialize_box(connection: "asyncpg.Connection") -> None:
    """Create :data:`BOX_SCHEMA`, its tables and its marker (idempotent).

    Run by ``hermes db migrate`` as the schema owner. Refuses a schema that a
    profile has claimed (a ``schema_owner`` table in it): that would mean a
    profile is writing its app tables here.
    """
    await connection.execute(DDL)
    await _refuse_profile_claim(connection)
    await connection.execute(
        f"INSERT INTO {BOX_SCHEMA}.box_marker (singleton, kind) VALUES (TRUE, $1) "
        "ON CONFLICT (singleton) DO NOTHING",
        BOX_MARKER_KIND,
    )
    kind = await connection.fetchval(f"SELECT kind FROM {BOX_SCHEMA}.box_marker")
    if kind != BOX_MARKER_KIND:
        raise BoxSchemaError(f"Schema {BOX_SCHEMA!r} carries a foreign marker {kind!r}")


async def _refuse_profile_claim(connection: "asyncpg.Connection") -> None:
    claimed = await connection.fetchval(
        "SELECT to_regclass($1)", f"{BOX_SCHEMA}.schema_owner"
    )
    if claimed is not None:
        raise BoxSchemaError(
            f"Schema {BOX_SCHEMA!r} has a profile schema_owner marker; refusing to "
            "use it as the box registry."
        )


def box_dsn(config: Optional[Mapping[str, Any]] = None) -> str:
    """The datastore DSN (the same Postgres as every profile schema)."""
    from hermes_cli.datastore import get_store

    return get_store("supabase-app", "prod", config=config).dsn


async def connect_box(
    *,
    config: Optional[Mapping[str, Any]] = None,
    dsn: Optional[str] = None,
) -> "asyncpg.Connection":
    """Open a connection with ``search_path`` pinned to :data:`BOX_SCHEMA`.

    Uses the existing datastore DSN (or ``dsn``) and deliberately does *not*
    run the per-profile :func:`~hermes_cli.datastore.verify_schema_owner`: the
    box schema belongs to no profile. When the login owns the database (the
    ``postgres`` DSN every box uses today) the tables are created on first use;
    a least-privilege login needs ``hermes db migrate`` to have run first.
    """
    from hermes_cli.datastore import _dsn_missing

    target = dsn if dsn is not None else box_dsn(config)
    if _dsn_missing(target):
        raise BoxSchemaError(
            "The source registry needs the app datastore; set "
            "datastore.supabase_app.dsn in config.yaml."
        )
    from tools.lazy_deps import ensure

    ensure("datastore.supabase")
    import asyncpg

    from hermes_cli import db_setup

    connection = await asyncpg.connect(
        target,
        server_settings={"search_path": BOX_SCHEMA},
        connection_class=db_setup.connection_class(),
    )
    try:
        allowed = await db_setup.bind(connection, BOX_SCHEMA)
        if allowed:
            await initialize_box(connection)
        else:
            await _refuse_profile_claim(connection)
            marker = await connection.fetchval(
                "SELECT to_regclass($1)", f"{BOX_SCHEMA}.box_marker"
            )
            if marker is None:
                raise BoxSchemaError(
                    f"Schema {BOX_SCHEMA!r} is not set up; run `hermes db migrate` "
                    "with the admin database address."
                )
    except BaseException:
        await connection.close()
        raise
    return connection


# -- row mapping -------------------------------------------------------------


def _json(value: Any) -> Optional[dict[str, Any]]:
    if value is None:
        return None
    if isinstance(value, str):
        return json.loads(value)
    return dict(value)


def _route(row: Mapping[str, Any]) -> Route:
    return Route(
        source_id=str(row["source_id"]),
        profile_slug=str(row["profile_slug"]),
        enabled=bool(row["enabled"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _source(row: Mapping[str, Any], routes: Sequence[Route] = ()) -> Source:
    return Source(
        source_id=str(row["source_id"]),
        channel=str(row["channel"]),
        address=str(row["address"]),
        owner_user_id=str(row["owner_user_id"]),
        display=row["display"],
        credential_ref=_json(row["credential_ref"]),
        enabled=bool(row["enabled"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        routes=tuple(routes),
    )


def _conflict(row: Mapping[str, Any]) -> ClaimConflict:
    return ClaimConflict(
        conflict_id=int(row["conflict_id"]),
        channel=str(row["channel"]),
        address=str(row["address"]),
        claimant_user_id=str(row["claimant_user_id"]),
        existing_owner_user_id=row["existing_owner_user_id"],
        detail=str(row["detail"] or ""),
        created_at=row["created_at"],
        resolved_at=row["resolved_at"],
    )


_SOURCE_COLS = (
    "source_id, channel, address, owner_user_id, display, credential_ref, "
    "enabled, created_at, updated_at"
)
_ROUTE_COLS = "source_id, profile_slug, enabled, created_at, updated_at"


async def _with_routes(connection: "asyncpg.Connection", rows: Sequence[Any]) -> list[Source]:
    if not rows:
        return []
    ids = [row["source_id"] for row in rows]
    route_rows = await connection.fetch(
        f"SELECT {_ROUTE_COLS} FROM {BOX_SCHEMA}.source_routes "
        "WHERE source_id = ANY($1::uuid[]) ORDER BY profile_slug",
        ids,
    )
    by_source: dict[str, list[Route]] = {}
    for route_row in route_rows:
        route = _route(route_row)
        by_source.setdefault(route.source_id, []).append(route)
    return [_source(row, by_source.get(str(row["source_id"]), ())) for row in rows]


async def get_source(connection: "asyncpg.Connection", source_id: str) -> Optional[Source]:
    """The source with ``source_id`` (and its routes), or ``None``."""
    try:
        key = uuid.UUID(str(source_id))
    except ValueError:
        return None
    row = await connection.fetchrow(
        f"SELECT {_SOURCE_COLS} FROM {BOX_SCHEMA}.sources WHERE source_id = $1", key
    )
    if row is None:
        return None
    return (await _with_routes(connection, [row]))[0]


async def _require_source(connection: "asyncpg.Connection", source_id: str) -> Source:
    source = await get_source(connection, source_id)
    if source is None:
        raise SourceNotFound(f"No such source: {source_id}")
    return source


# -- membership / authority --------------------------------------------------


def _registry_entry(profile_slug: str) -> Any:
    from hermes_cli.profile_registry import get_profile_registry

    return next((e for e in get_profile_registry() if e.name == profile_slug), None)


async def is_active_in_profile(user_id: str, profile_slug: str) -> bool:
    """Whether ``user_id`` holds an **active** ``principals`` row in that profile.

    Enters the profile's runtime scope and asks its own ``principals`` table
    (the FG-28 console-scope seam), so the answer is that profile's, never a
    copy held here.
    """
    from hermes_cli.console_scope import (
        _principal_for_subject,
        _scoped_to,
        principal_store_factory,
    )

    entry = _registry_entry(profile_slug)
    if entry is None or not entry.hermes_home.is_dir():
        return False
    factory = principal_store_factory()
    with _scoped_to(entry.hermes_home):
        principal = await _principal_for_subject(factory(entry.hermes_home), user_id)
    return principal is not None and bool(getattr(principal, "active", True))


async def active_profiles_for(user_id: str) -> list[str]:
    """Every profile on the box where ``user_id`` is an active member."""
    from hermes_cli.console_scope import enrolled_profiles, principal_store_factory

    return await enrolled_profiles(
        user_id, store_factory=principal_store_factory(), active_only=True
    )


async def is_box_admin(user_id: str) -> bool:
    """The box owner/admin: an active ``owner``/``admin`` of the default profile.

    The default profile is the install's own (its owner is the install owner
    that unowned sources fall back to), so its owners/admins run the box.
    """
    from hermes_cli.console_scope import (
        _principal_for_subject,
        _scoped_to,
        principal_store_factory,
    )

    entry = _registry_entry("default")
    if not user_id or entry is None:
        return False
    factory = principal_store_factory()
    with _scoped_to(entry.hermes_home):
        principal = await _principal_for_subject(factory(entry.hermes_home), user_id)
    return (
        principal is not None
        and bool(getattr(principal, "active", True))
        and getattr(principal, "role", "") in ("owner", "admin")
    )


# -- the contract ------------------------------------------------------------


async def get_source_by_address(
    connection: "asyncpg.Connection", channel: str, address: str
) -> Optional[Source]:
    """The source registered for ``(channel, address)``; ``address`` is normalised."""
    channel = normalize_channel(channel)
    normalized = normalize_address(channel, address)
    row = await connection.fetchrow(
        f"SELECT {_SOURCE_COLS} FROM {BOX_SCHEMA}.sources "
        "WHERE channel = $1 AND address = $2",
        channel,
        normalized,
    )
    if row is None:
        return None
    return (await _with_routes(connection, [row]))[0]


async def register_source(
    connection: "asyncpg.Connection",
    *,
    channel: str,
    address: str,
    owner_user_id: str,
    display: Optional[str] = None,
    credential_ref: Optional[Mapping[str, Any]] = None,
) -> Source:
    """Register ``(channel, address)`` to ``owner_user_id``; returns the source.

    The same owner registering again is idempotent: it updates ``display`` /
    ``credential_ref`` when given and keeps the routes. A different owner is
    refused with :class:`SourceOwnedByAnotherUser` (which names nobody) and the
    refused claim is recorded with :func:`record_conflict`.
    """
    channel = normalize_channel(channel)
    normalized = normalize_address(channel, address)
    owner = _check_user(owner_user_id, "owner user id")
    ref = _check_credential_ref(credential_ref)
    ref_json = json.dumps(ref) if ref is not None else None
    async with connection.transaction():
        row = await connection.fetchrow(
            f"""
            INSERT INTO {BOX_SCHEMA}.sources
                (source_id, channel, address, owner_user_id, display, credential_ref)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            ON CONFLICT (channel, address) DO UPDATE SET
                display = COALESCE(EXCLUDED.display, {BOX_SCHEMA}.sources.display),
                credential_ref = COALESCE(EXCLUDED.credential_ref,
                                          {BOX_SCHEMA}.sources.credential_ref),
                updated_at = NOW()
            WHERE {BOX_SCHEMA}.sources.owner_user_id = EXCLUDED.owner_user_id
            RETURNING {_SOURCE_COLS}
            """,
            uuid.uuid4(),
            channel,
            normalized,
            owner,
            display,
            ref_json,
        )
        if row is not None:
            return (await _with_routes(connection, [row]))[0]
        existing = await connection.fetchval(
            f"SELECT owner_user_id FROM {BOX_SCHEMA}.sources "
            "WHERE channel = $1 AND address = $2",
            channel,
            normalized,
        )
    await record_conflict(
        connection,
        channel=channel,
        address=normalized,
        claimant_user_id=owner,
        existing_owner_user_id=existing,
        detail="register refused: already registered to another user",
    )
    raise SourceOwnedByAnotherUser(channel, normalized)


async def set_route(
    connection: "asyncpg.Connection",
    *,
    source_id: str,
    profile_slug: str,
    enabled: bool,
    actor_user_id: str,
    membership: Optional[MembershipCheck] = None,
) -> Route:
    """Turn the route from ``source_id`` to ``profile_slug`` on or off.

    Only the source owner may change its routes (not even the box admin: the
    owner decides where their mail is read). Enabling a route to a profile the
    owner is not an active member of raises :class:`ProfileNotEnrolled`;
    turning a route *off* is always allowed, so a stale route can be cleared
    after the owner left that profile.
    """
    profile = _check_profile(profile_slug)
    actor = _check_user(actor_user_id, "actor")
    source = await _require_source(connection, source_id)
    if source.owner_user_id != actor:
        raise SourcePermissionError("Only the source's owner can change where it routes.")
    if enabled:
        check = membership or is_active_in_profile
        if not await check(source.owner_user_id, profile):
            raise ProfileNotEnrolled(
                f"You are not an active member of profile {profile!r}, so this "
                "source cannot route there."
            )
    row = await connection.fetchrow(
        f"""
        INSERT INTO {BOX_SCHEMA}.source_routes (source_id, profile_slug, enabled)
        VALUES ($1, $2, $3)
        ON CONFLICT (source_id, profile_slug) DO UPDATE
            SET enabled = EXCLUDED.enabled, updated_at = NOW()
        RETURNING {_ROUTE_COLS}
        """,
        uuid.UUID(source.source_id),
        profile,
        bool(enabled),
    )
    return _route(row)


async def list_sources(
    connection: "asyncpg.Connection",
    *,
    owner_user_id: Optional[str] = None,
    channel: Optional[str] = None,
) -> list[Source]:
    """Sources (each with its routes), optionally one owner's / one channel's.

    Callers serving a person pass their ``owner_user_id``; only the box owner/
    admin lists everyone's (``owner_user_id=None``).
    """
    clauses: list[str] = []
    params: list[Any] = []
    if owner_user_id is not None:
        params.append(owner_user_id)
        clauses.append(f"owner_user_id = ${len(params)}")
    if channel is not None:
        params.append(normalize_channel(channel))
        clauses.append(f"channel = ${len(params)}")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = await connection.fetch(
        f"SELECT {_SOURCE_COLS} FROM {BOX_SCHEMA}.sources {where} "
        "ORDER BY channel, address",
        *params,
    )
    return await _with_routes(connection, rows)


async def routed_profiles(connection: "asyncpg.Connection", source_id: str) -> list[str]:
    """Profiles the source routes to: enabled routes of an enabled source only."""
    try:
        key = uuid.UUID(str(source_id))
    except ValueError:
        return []
    rows = await connection.fetch(
        f"""
        SELECT r.profile_slug FROM {BOX_SCHEMA}.source_routes r
        JOIN {BOX_SCHEMA}.sources s ON s.source_id = r.source_id
        WHERE r.source_id = $1 AND r.enabled AND s.enabled
        ORDER BY r.profile_slug
        """,
        key,
    )
    return [str(row["profile_slug"]) for row in rows]


async def set_source_enabled(
    connection: "asyncpg.Connection",
    *,
    source_id: str,
    enabled: bool,
    actor_user_id: str,
    box_admin: Optional[BoxAdminCheck] = None,
) -> Source:
    """Pause or resume a whole source (owner, or box owner/admin)."""
    source = await _require_source(connection, source_id)
    await _require_owner_or_admin(source, actor_user_id, box_admin)
    await connection.execute(
        f"UPDATE {BOX_SCHEMA}.sources SET enabled = $2, updated_at = NOW() "
        "WHERE source_id = $1",
        uuid.UUID(source.source_id),
        bool(enabled),
    )
    return await _require_source(connection, source.source_id)


async def _require_owner_or_admin(
    source: Source, actor_user_id: str, box_admin: Optional[BoxAdminCheck]
) -> None:
    actor = _check_user(actor_user_id, "actor")
    if source.owner_user_id == actor:
        return
    if await (box_admin or is_box_admin)(actor):
        return
    raise SourcePermissionError("Only the source's owner or the box owner can do that.")


async def transfer_source(
    connection: "asyncpg.Connection",
    *,
    source_id: str,
    new_owner_user_id: str,
    actor_user_id: str,
    box_admin: Optional[BoxAdminCheck] = None,
) -> Source:
    """Give a source to another user (box owner/admin only); drops every route.

    Routes belong to the old owner's user-profiles, so none survive: the new
    owner picks their own. Open conflicts for this address raised by the new
    owner are marked resolved.
    """
    actor = _check_user(actor_user_id, "actor")
    new_owner = _check_user(new_owner_user_id, "new owner user id")
    if not await (box_admin or is_box_admin)(actor):
        raise SourcePermissionError("Only the box owner or an admin can transfer a source.")
    source = await _require_source(connection, source_id)
    key = uuid.UUID(source.source_id)
    async with connection.transaction():
        await connection.execute(
            f"DELETE FROM {BOX_SCHEMA}.source_routes WHERE source_id = $1", key
        )
        await connection.execute(
            f"UPDATE {BOX_SCHEMA}.sources SET owner_user_id = $2, updated_at = NOW() "
            "WHERE source_id = $1",
            key,
            new_owner,
        )
        await connection.execute(
            f"UPDATE {BOX_SCHEMA}.source_claim_conflicts SET resolved_at = NOW() "
            "WHERE channel = $1 AND address = $2 AND claimant_user_id = $3 "
            "AND resolved_at IS NULL",
            source.channel,
            source.address,
            new_owner,
        )
    return await _require_source(connection, source.source_id)


async def remove_source(
    connection: "asyncpg.Connection",
    *,
    source_id: str,
    actor_user_id: str,
    box_admin: Optional[BoxAdminCheck] = None,
) -> bool:
    """Delete a source and its routes (its owner, or box owner/admin)."""
    source = await get_source(connection, source_id)
    if source is None:
        return False
    await _require_owner_or_admin(source, actor_user_id, box_admin)
    status = await connection.execute(
        f"DELETE FROM {BOX_SCHEMA}.sources WHERE source_id = $1",
        uuid.UUID(source.source_id),
    )
    return status.endswith(" 1")


async def record_conflict(
    connection: "asyncpg.Connection",
    *,
    channel: str,
    address: str,
    claimant_user_id: str,
    existing_owner_user_id: Optional[str],
    detail: str = "",
) -> ClaimConflict:
    """Record a disputed claim (one open row per claimant and address)."""
    channel = normalize_channel(channel)
    normalized = normalize_address(channel, address)
    row = await connection.fetchrow(
        f"""
        INSERT INTO {BOX_SCHEMA}.source_claim_conflicts
            (channel, address, claimant_user_id, existing_owner_user_id, detail)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (channel, address, claimant_user_id) WHERE resolved_at IS NULL
        DO UPDATE SET existing_owner_user_id = EXCLUDED.existing_owner_user_id,
                      detail = EXCLUDED.detail
        RETURNING conflict_id, channel, address, claimant_user_id,
                  existing_owner_user_id, detail, created_at, resolved_at
        """,
        channel,
        normalized,
        _check_user(claimant_user_id, "claimant"),
        existing_owner_user_id,
        detail or "",
    )
    return _conflict(row)


async def list_conflicts(
    connection: "asyncpg.Connection",
    *,
    user_id: Optional[str] = None,
    include_resolved: bool = False,
) -> list[ClaimConflict]:
    """Claim conflicts; with ``user_id`` only those they raised or are the owner in."""
    clauses: list[str] = []
    params: list[Any] = []
    if user_id is not None:
        params.append(user_id)
        clauses.append(
            f"(claimant_user_id = ${len(params)} OR existing_owner_user_id = ${len(params)})"
        )
    if not include_resolved:
        clauses.append("resolved_at IS NULL")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = await connection.fetch(
        f"""
        SELECT conflict_id, channel, address, claimant_user_id,
               existing_owner_user_id, detail, created_at, resolved_at
        FROM {BOX_SCHEMA}.source_claim_conflicts {where}
        ORDER BY created_at, conflict_id
        """,
        *params,
    )
    return [_conflict(row) for row in rows]


async def resolve_conflict(
    connection: "asyncpg.Connection",
    *,
    conflict_id: int,
    actor_user_id: str,
    box_admin: Optional[BoxAdminCheck] = None,
) -> bool:
    """Mark a conflict resolved (box owner/admin only)."""
    actor = _check_user(actor_user_id, "actor")
    if not await (box_admin or is_box_admin)(actor):
        raise SourcePermissionError("Only the box owner or an admin can resolve conflicts.")
    status = await connection.execute(
        f"UPDATE {BOX_SCHEMA}.source_claim_conflicts SET resolved_at = NOW() "
        "WHERE conflict_id = $1 AND resolved_at IS NULL",
        int(conflict_id),
    )
    return status.endswith(" 1")


# -- lifecycle hooks ----------------------------------------------------------


async def disable_routes_for_profile(
    connection: "asyncpg.Connection", *, user_id: str, profile_slug: str
) -> int:
    """Disable ``user_id``'s sources' routes to ``profile_slug``; the count changed.

    Called when the person is removed from that profile. Routes are disabled,
    not deleted, so re-enrolling and turning the route back on is the owner's
    choice and their history stays readable.
    """
    status = await connection.execute(
        f"""
        UPDATE {BOX_SCHEMA}.source_routes r SET enabled = FALSE, updated_at = NOW()
        FROM {BOX_SCHEMA}.sources s
        WHERE s.source_id = r.source_id AND s.owner_user_id = $1
          AND r.profile_slug = $2 AND r.enabled
        """,
        user_id,
        profile_slug,
    )
    return _count(status)


async def remove_sources_for_user(connection: "asyncpg.Connection", *, user_id: str) -> int:
    """Delete every source ``user_id`` owns (routes cascade); the count removed.

    Called when the person is removed from the box (no profile enrols them).
    """
    status = await connection.execute(
        f"DELETE FROM {BOX_SCHEMA}.sources WHERE owner_user_id = $1", user_id
    )
    return _count(status)


def _count(status: str) -> int:
    try:
        return int(str(status).rsplit(" ", 1)[-1])
    except ValueError:
        return 0


def profile_for_schema(schema: str) -> Optional[str]:
    """The profile name whose prod app schema is ``schema`` (None for dev/unknown)."""
    from hermes_cli.datastore import app_schema

    if schema == "app_prod":
        return "default"
    if not schema.startswith("app_prod_"):
        return None
    from hermes_cli.profile_registry import get_profile_registry

    for entry in get_profile_registry():
        if app_schema("prod", profile=entry.name) == schema:
            return entry.name
    return None


async def _box_ready(connection: "asyncpg.Connection") -> bool:
    found = await connection.fetchval(
        "SELECT to_regclass($1)", f"{BOX_SCHEMA}.source_routes"
    )
    return isinstance(found, str)


async def on_principal_removed(
    connection: "asyncpg.Connection", *, schema: str, user_id: str
) -> int:
    """Hook for :meth:`PrincipalStore.unenroll`: disable routes to that profile.

    Runs on the profile's own connection (same database, schema-qualified SQL),
    so it needs no second login. A box without the registry is a no-op. Never
    raises: the ``principals`` row is already gone and stays the source of truth.
    """
    try:
        profile = profile_for_schema(schema)
        if profile is None or not await _box_ready(connection):
            return 0
        # A savepoint when the caller is mid-transaction: a refused write here
        # (e.g. missing grants) must not abort the caller's principals change.
        async with connection.transaction():
            return await disable_routes_for_profile(
                connection, user_id=user_id, profile_slug=profile
            )
    except Exception as exc:  # noqa: BLE001 - best-effort hook
        logger.warning("source registry: could not disable routes for %s: %s", user_id, exc)
        return 0


async def on_person_left_box(connection: "asyncpg.Connection", *, user_id: str) -> int:
    """Hook for a member removal that leaves the person in no profile: drop their sources.

    Never raises (best-effort, like the memory-file purge beside it).
    """
    try:
        if await active_or_suspended_anywhere(user_id):
            return 0
        if not await _box_ready(connection):
            return 0
        return await remove_sources_for_user(connection, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - best-effort hook
        logger.warning("source registry: could not remove sources of %s: %s", user_id, exc)
        return 0


async def active_or_suspended_anywhere(user_id: str) -> bool:
    """Whether ``user_id`` still has any principals row (suspended included) on the box."""
    from hermes_cli.console_scope import enrolled_profiles, principal_store_factory

    return bool(await enrolled_profiles(user_id, store_factory=principal_store_factory()))
