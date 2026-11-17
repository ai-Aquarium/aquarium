"""FG-03 P2 — move today's mailboxes, WhatsApp numbers and Telegram bots into
the box-level source registry (:mod:`hermes_cli.source_registry`).

``hermes source migrate [--dry-run] [--json]`` and a step of ``hermes db
migrate``. Safe to run again: a source already in the registry keeps its
owner, an existing route (on or off) is left as its owner set it, and a claim
already recorded (open or resolved) is not recorded again, so a second run
writes nothing.

**Where sources come from** (the formats of the real loaders):

- *email*: the box-wide poller config (``config.yaml
  email_poller.config_path``, else ``EMAIL_CONFIG_PATH``, else
  ``/opt/data/email-messages/config.json``) ``accounts[]``; and in every
  profile the ``email-imap`` mailbox credentials
  (:func:`hermes_cli.email_mailboxes.all_mailboxes`) and the Google accounts
  that opted into the ``email`` service.
- *whatsapp*: ``/opt/data/whatsapp-messages/config.json`` ``phones[]``; and in
  every profile ``<HERMES_HOME>/whatsapp/bridge-owners.json`` (a bridge's
  number is read from its linked session's ``creds.json``).
- *telegram*: in every profile the per-person ``telegram-bot`` credentials.
  The install bot (``TELEGRAM_BOT_TOKEN``) is **not** a source: it is the
  profile's operator bot that answers every allowed user (the gateway never
  runs a person bot with the same id, see
  :func:`gateway.person_telegram_bots.desired_person_bots`), so it has no
  single owner. It is listed under *skipped*.

**Owner.** Only an explicit owner counts, never the pollers' fallback chains:

1. rank 0 — whoever saved the credential (mailbox, Google account, Telegram
   bot) or added the bridge (``bridge-owners.json``);
2. rank 1 — a box-wide config assignment: the Settings › Accounts choice
   (``account_owners``, any profile) or the config entry's ``owner_user_id``.

A source with no explicit owner is assigned to the install owner (the default
profile's owner) and flagged. When several *different* users claim the same
normalised address, the first by (rank, earliest created — entries without a
time last, profile name, user id) is registered and every other claimant gets
a claim conflict for the box owner to resolve.

**Routes.** Each source routes to the profiles it is configured in today: the
profile its credential or bridge came from; the box-wide config files route to
``default``. A route is only made when the owner is an active member of that
profile, and never for an entry disabled in its config; otherwise the report
says why.

``credential_ref`` only points at the credential (profile, kind, provider,
name, owner, bridge, port); no secret is ever copied. A Telegram token is read
only to derive the bot id.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

from hermes_cli import source_registry as registry

logger = logging.getLogger(__name__)

EMAIL_CONFIG_PATH = "/opt/data/email-messages/config.json"
WHATSAPP_CONFIG_PATH = "/opt/data/whatsapp-messages/config.json"
#: Box-wide config files are triaged by the default profile's pipelines.
BOX_CONFIG_PROFILE = "default"
#: ``pg_advisory_xact_lock`` key so two runs never interleave.
_LOCK_KEY = 0x46473033  # "FG03"

RANK_CONNECTED = 0
RANK_ASSIGNED = 1

Membership = Callable[[str, str], Awaitable[bool]]


@dataclass(frozen=True)
class SourcePaths:
    """The box-wide config files; ``None`` means the pollers' own default."""

    email_config: Optional[Path] = None
    whatsapp_config: Optional[Path] = None


@dataclass(frozen=True)
class Candidate:
    """One place today that says "this address is a source"."""

    channel: str
    address: str
    owner_user_id: Optional[str]
    rank: int
    profile: str
    found_in: str
    decided_by: str
    created_at: Optional[datetime] = None
    credential_ref: Optional[Dict[str, Any]] = None
    display: Optional[str] = None
    route: bool = True
    route_note: str = ""

    @property
    def explicit(self) -> bool:
        return bool(self.owner_user_id)

    def sort_key(self) -> Tuple[Any, ...]:
        when = self.created_at.timestamp() if self.created_at else 0.0
        return (self.rank, self.created_at is None, when, self.profile, self.owner_user_id or "")


@dataclass
class Discovery:
    candidates: List[Candidate] = field(default_factory=list)
    skipped: List[Dict[str, str]] = field(default_factory=list)
    install_owner_user_id: Optional[str] = None

    def skip(self, item: str, reason: str) -> None:
        self.skipped.append({"item": item, "reason": reason})


# -- reading today's state -------------------------------------------------------


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    return data if isinstance(data, dict) else {}


def _email_config_path(paths: SourcePaths) -> Path:
    if paths.email_config is not None:
        return Path(paths.email_config)
    from hermes_cli.config import cfg_get, load_config_readonly

    configured = str(
        cfg_get(load_config_readonly() or {}, "email_poller", "config_path", default="") or ""
    ).strip()
    return Path(configured or os.environ.get("EMAIL_CONFIG_PATH") or EMAIL_CONFIG_PATH)


def _whatsapp_config_path(paths: SourcePaths) -> Path:
    return Path(paths.whatsapp_config) if paths.whatsapp_config is not None else Path(WHATSAPP_CONFIG_PATH)


def _as_time(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return datetime.fromtimestamp(value, tz=timezone.utc)
    return None


def _normalized(channel: str, raw: Any) -> Optional[str]:
    try:
        return registry.normalize_address(channel, str(raw or ""))
    except registry.SourceRegistryError:
        return None


def _linked_number(session_dir: Path) -> Optional[str]:
    """Digits of the number a WhatsApp session is linked to (``creds.json``)."""
    try:
        creds = json.loads((session_dir / "creds.json").read_text())
    except (OSError, ValueError):
        return None
    me = creds.get("me") if isinstance(creds, dict) else None
    digits = re.split(r"[:@]", str((me or {}).get("id") or ""), maxsplit=1)[0]
    return digits if digits.isdigit() else None


def _bot_id(token: Any) -> Optional[str]:
    bot_id = str(token or "").strip().split(":", 1)[0]
    return bot_id if bot_id.isdigit() else None


async def _profile_owner(config: Dict[str, Any]) -> Any:
    from hermes_cli.access import PrincipalStore
    from hermes_cli.datastore import get_store

    store = get_store("supabase-app", "prod", config=config)
    if not store.dsn:
        return None
    return await PrincipalStore(store).get_owner()


async def _settings_choices(config: Dict[str, Any], owner: Any) -> List[Any]:
    """This profile's Settings › Accounts choices (``account_owners``)."""
    from hermes_cli.account_owners import AccountOwnerStore
    from hermes_cli.datastore import get_store

    store = get_store("supabase-app", "prod", config=config)
    if not store.dsn or owner is None:
        return []
    connection = await store.connect()
    try:
        exists = await connection.fetchval("SELECT to_regclass('account_owners')")
    finally:
        await connection.close()
    if exists is None:
        return []
    return await AccountOwnerStore(store).list(owner)


async def _discover_profile(entry: Any, found: Discovery, choices: List[Tuple[str, Any]]) -> None:
    """Credentials, bridges and Settings choices of one profile (in its scope)."""
    from agent.secret_scope import load_env_file
    from hermes_cli.config import load_config_readonly
    from hermes_cli.credential_store import default_credential_store
    from hermes_cli.email_mailboxes import all_mailboxes
    from hermes_cli.wa_bridge_owners import load_owners, session_dir

    profile = entry.name
    config = dict(load_config_readonly() or {})
    store = default_credential_store(config)
    supabase = getattr(store, "backend", "") == "supabase"
    owner = None
    if supabase:
        owner = await _profile_owner(config)
        if owner is None:
            found.skip(
                f"profile {profile}: credentials",
                "the profile has no owner yet, so its credentials cannot be read",
            )
    if profile == "default" and owner is not None:
        found.install_owner_user_id = owner.user_id

    readable = owner is not None or not supabase
    if readable:
        try:
            for cred in await all_mailboxes():
                address = _normalized("email", cred.name)
                if address is None:
                    found.skip(f"profile {profile}: mailbox {cred.name!r}", "not an email address")
                    continue
                found.candidates.append(Candidate(
                    channel="email", address=address, owner_user_id=cred.owner_user_id or None,
                    rank=RANK_CONNECTED, profile=profile,
                    found_in=f"{profile}: email-imap mailbox credential",
                    decided_by="saved the mailbox credential",
                    created_at=_as_time(cred.created_at), display=cred.name,
                    credential_ref={"profile": profile, "kind": cred.kind, "provider": cred.provider,
                                    "name": cred.name, "owner_user_id": cred.owner_user_id},
                ))
            for cred in await store.resolve_for_service("email", provider="google"):
                address = _normalized("email", cred.name)
                if address is None:
                    found.skip(f"profile {profile}: Google account {cred.name!r}", "not an email address")
                    continue
                found.candidates.append(Candidate(
                    channel="email", address=address, owner_user_id=cred.owner_user_id or None,
                    rank=RANK_CONNECTED, profile=profile,
                    found_in=f"{profile}: Google account (email service)",
                    decided_by="connected the Google account",
                    created_at=_as_time(cred.created_at), display=cred.name,
                    credential_ref={"profile": profile, "kind": cred.kind, "provider": cred.provider,
                                    "name": cred.name, "owner_user_id": cred.owner_user_id},
                ))
            install_bot = _bot_id(load_env_file(Path(entry.hermes_home) / ".env").get("TELEGRAM_BOT_TOKEN"))
            for cred in await store.resolve_by_kind("telegram-bot", provider="telegram"):
                bot_id = _bot_id((cred.payload or {}).get("token"))
                label = f"profile {profile}: Telegram bot of {cred.owner_user_id}"
                if bot_id is None:
                    found.skip(label, "no bot token saved yet")
                    continue
                if bot_id == install_bot:
                    found.skip(label, f"bot {bot_id} is this profile's install bot; the gateway never runs it as a person bot")
                    continue
                username = (cred.payload or {}).get("bot_username")
                linked = bool((cred.payload or {}).get("linked_user_id"))
                found.candidates.append(Candidate(
                    channel="telegram", address=bot_id, owner_user_id=cred.owner_user_id or None,
                    rank=RANK_CONNECTED, profile=profile,
                    found_in=f"{profile}: telegram-bot credential" + ("" if linked else " (not linked yet)"),
                    decided_by="saved the Telegram bot",
                    created_at=_as_time(cred.created_at),
                    display=f"@{username}" if username else None,
                    credential_ref={"profile": profile, "kind": cred.kind, "provider": cred.provider,
                                    "name": cred.name, "owner_user_id": cred.owner_user_id},
                ))
        except Exception as exc:  # noqa: BLE001 - one unreadable profile must not stop the rest
            found.skip(f"profile {profile}: credentials", f"could not be read ({type(exc).__name__}: {exc})")
    if install_bot_token := load_env_file(Path(entry.hermes_home) / ".env").get("TELEGRAM_BOT_TOKEN"):
        found.skip(
            f"profile {profile}: install Telegram bot {_bot_id(install_bot_token) or '?'}",
            "the profile's operator bot answers every allowed user, so it is not one person's source",
        )

    for name, rec in sorted(load_owners().items()):
        label = f"profile {profile}: WhatsApp bridge {name!r}"
        number = _linked_number(session_dir(name))
        if number is None or _normalized("whatsapp", number) is None:
            found.skip(label, "the bridge is not linked to a phone yet (no number in its session)")
            continue
        ref: Dict[str, Any] = {"profile": profile, "kind": "wa-bridge", "bridge": name,
                               "owner_user_id": rec["user_id"]}
        if isinstance(rec.get("port"), int):
            ref["port"] = rec["port"]
        found.candidates.append(Candidate(
            channel="whatsapp", address=_normalized("whatsapp", number) or number,
            owner_user_id=rec["user_id"], rank=RANK_CONNECTED, profile=profile,
            found_in=f"{profile}: bridge-owners.json bridge {name!r}",
            decided_by="added the WhatsApp bridge", created_at=_as_time(rec.get("added_at")),
            display=name, credential_ref=ref,
        ))

    if supabase and owner is not None:
        try:
            choices.extend((profile, c) for c in await _settings_choices(config, owner))
        except Exception as exc:  # noqa: BLE001
            found.skip(f"profile {profile}: Settings › Accounts", f"could not be read ({type(exc).__name__}: {exc})")


def _choice_candidates(
    channel: str, surface: str, key: Any, address: str, choices: Sequence[Tuple[str, Any]], **common: Any
) -> List[Candidate]:
    from hermes_cli.account_owners import account_key

    try:
        wanted = account_key(surface, key)
    except ValueError:
        return []
    return [
        Candidate(
            channel=channel, address=address, owner_user_id=choice.owner_user_id,
            rank=RANK_ASSIGNED, decided_by=f"Settings › Accounts choice in profile {profile}",
            created_at=_as_time(choice.set_at), **common,
        )
        for profile, choice in choices
        if choice.surface == surface and choice.account_key == wanted
    ]


def _discover_box_configs(found: Discovery, paths: SourcePaths, choices: Sequence[Tuple[str, Any]]) -> None:
    email_path = _email_config_path(paths)
    try:
        accounts = _read_json(email_path).get("accounts", [])
    except (OSError, ValueError) as exc:
        found.skip(f"email config {email_path}", f"could not be read ({exc})")
        accounts = []
    for account in accounts if isinstance(accounts, list) else []:
        if not isinstance(account, dict) or not account.get("address"):
            continue
        label = f"email config {email_path} account {account.get('id') or account['address']!r}"
        address = _normalized("email", account["address"])
        if address is None:
            found.skip(label, "not an email address")
            continue
        enabled = bool(account.get("enabled", True))
        common: Dict[str, Any] = dict(
            profile=BOX_CONFIG_PROFILE, found_in=f"box-wide email config ({email_path})",
            display=str(account.get("label") or account.get("name") or account["address"]),
            credential_ref={"kind": "email-poller-config", "name": str(account.get("id") or address)},
            route=enabled, route_note="" if enabled else "disabled in the email config",
        )
        found.candidates.extend(_choice_candidates("email", "email", account["address"], address, choices, **common))
        owner = str(account.get("owner_user_id") or "").strip() or None
        found.candidates.append(Candidate(
            channel="email", address=address, owner_user_id=owner, rank=RANK_ASSIGNED,
            decided_by="owner_user_id in the email config" if owner else "no owner in the email config",
            **common,
        ))

    wa_path = _whatsapp_config_path(paths)
    try:
        phones = _read_json(wa_path).get("phones", [])
    except (OSError, ValueError) as exc:
        found.skip(f"WhatsApp config {wa_path}", f"could not be read ({exc})")
        phones = []
    for phone in phones if isinstance(phones, list) else []:
        if not isinstance(phone, dict) or not phone.get("id"):
            continue
        label = f"WhatsApp config {wa_path} phone {phone['id']!r}"
        address = _normalized("whatsapp", phone.get("number"))
        if address is None and phone.get("session_dir"):
            address = _normalized("whatsapp", _linked_number(Path(str(phone["session_dir"]))))
        if address is None:
            found.skip(label, "no full phone number (the config number is masked or missing and its session is not linked)")
            continue
        enabled = bool(phone.get("enabled", True))
        ref: Dict[str, Any] = {"kind": "wa-poller-config", "name": str(phone["id"])}
        if isinstance(phone.get("bridge_port"), int):
            ref["port"] = phone["bridge_port"]
        common = dict(
            profile=BOX_CONFIG_PROFILE, found_in=f"box-wide WhatsApp config ({wa_path})",
            display=str(phone.get("label") or phone["id"]), credential_ref=ref,
            route=enabled, route_note="" if enabled else "disabled in the WhatsApp config",
        )
        found.candidates.extend(_choice_candidates("whatsapp", "whatsapp", phone["id"], address, choices, **common))
        owner = str(phone.get("owner_user_id") or "").strip() or None
        found.candidates.append(Candidate(
            channel="whatsapp", address=address, owner_user_id=owner, rank=RANK_ASSIGNED,
            decided_by="owner_user_id in the WhatsApp config" if owner else "no owner in the WhatsApp config",
            **common,
        ))


async def discover(paths: Optional[SourcePaths] = None) -> Discovery:
    """Every source configured on the box today (reads only)."""
    from hermes_cli.console_scope import _scoped_to
    from hermes_cli.profile_registry import get_profile_registry

    paths = paths or SourcePaths()
    found = Discovery()
    choices: List[Tuple[str, Any]] = []
    entries = sorted(get_profile_registry(), key=lambda e: (not e.is_default, e.name))
    for entry in entries:
        if not Path(entry.hermes_home).is_dir():
            continue
        with _scoped_to(Path(entry.hermes_home)):
            try:
                await _discover_profile(entry, found, choices)
            except Exception as exc:  # noqa: BLE001
                found.skip(f"profile {entry.name}", f"could not be read ({type(exc).__name__}: {exc})")
    default = next((e for e in entries if e.is_default), None)
    if default is not None:
        with _scoped_to(Path(default.hermes_home)):
            _discover_box_configs(found, paths, choices)
    else:
        _discover_box_configs(found, paths, choices)
    return found


# -- deciding -------------------------------------------------------------------


@dataclass
class Plan:
    channel: str
    address: str
    owner_user_id: str
    decided_by: str
    assigned_to_install_owner: bool
    winner: Candidate
    candidates: List[Candidate]
    #: Explicit claimants that lose: ``{user_id: best candidate}``.
    losers: Dict[str, Candidate]


def plan(found: Discovery) -> List[Plan]:
    """One :class:`Plan` per normalised address, by the documented rule."""
    groups: Dict[Tuple[str, str], List[Candidate]] = {}
    for candidate in found.candidates:
        groups.setdefault((candidate.channel, candidate.address), []).append(candidate)
    plans: List[Plan] = []
    for (channel, address), group in sorted(groups.items()):
        explicit = sorted((c for c in group if c.explicit), key=Candidate.sort_key)
        if explicit:
            winner = explicit[0]
            owner = str(winner.owner_user_id)
            decided_by = winner.decided_by
            install = False
        elif found.install_owner_user_id:
            winner = sorted(group, key=Candidate.sort_key)[0]
            owner = found.install_owner_user_id
            decided_by = "no explicit owner today"
            install = True
        else:
            found.skip(f"{channel} {address}", "no explicit owner and the box has no install owner yet")
            continue
        losers: Dict[str, Candidate] = {}
        for candidate in explicit:
            if candidate.owner_user_id != owner:
                losers.setdefault(str(candidate.owner_user_id), candidate)
        plans.append(Plan(channel, address, owner, decided_by, install, winner, group, losers))
    return plans


# -- applying ---------------------------------------------------------------------


async def _has_conflict(connection: Any, channel: str, address: str, claimant: str) -> bool:
    return bool(await connection.fetchval(
        f"SELECT 1 FROM {registry.BOX_SCHEMA}.source_claim_conflicts "
        "WHERE channel = $1 AND address = $2 AND claimant_user_id = $3 LIMIT 1",
        channel, address, claimant,
    ))


def _ref_of(item: Plan) -> Optional[Dict[str, Any]]:
    for candidate in sorted(item.candidates, key=Candidate.sort_key):
        if candidate.credential_ref and candidate.owner_user_id in (item.owner_user_id, None):
            return candidate.credential_ref
    return None


async def apply_plans(
    connection: Any,
    plans: Sequence[Plan],
    *,
    membership: Optional[Membership] = None,
) -> Dict[str, Any]:
    """Write ``plans`` into the registry; the report's ``sources`` and ``conflicts``."""
    check = membership or registry.may_route_to
    checked: Dict[Tuple[str, str], bool] = {}

    async def active(user_id: str, profile: str) -> bool:
        if (user_id, profile) not in checked:
            checked[(user_id, profile)] = bool(await check(user_id, profile))
        return checked[(user_id, profile)]

    async def already_checked(user_id: str, profile: str) -> bool:
        return checked.get((user_id, profile), False)

    sources: List[Dict[str, Any]] = []
    conflicts: List[Dict[str, Any]] = []
    for item in plans:
        existing = await registry.get_source_by_address(connection, item.channel, item.address)
        owner, decided_by = item.owner_user_id, item.decided_by
        claimants = dict(item.losers)
        if existing is None:
            try:
                existing = await registry.register_source(
                    connection, channel=item.channel, address=item.address,
                    owner_user_id=owner, display=item.winner.display, credential_ref=_ref_of(item),
                )
                action = "registered"
            except registry.SourceOwnedByAnotherUser:
                existing = await registry.get_source_by_address(connection, item.channel, item.address)
                action = "kept the registered owner"
        elif existing.owner_user_id == owner:
            action = "already registered"
        else:
            action = "kept the registered owner"
        assert existing is not None
        if existing.owner_user_id != owner:
            # The registry is authoritative once written: today's claimant loses.
            claimants.pop(existing.owner_user_id, None)
            if item.winner.explicit:
                claimants.setdefault(owner, item.winner)
            owner = existing.owner_user_id
            decided_by = "already registered to this owner"
        install = item.assigned_to_install_owner and owner == item.owner_user_id

        for claimant, candidate in sorted(claimants.items()):
            detail = (
                f"migration: {candidate.found_in} names {claimant}, but the source "
                f"went to {owner} ({decided_by})"
            )
            if await _has_conflict(connection, item.channel, item.address, claimant):
                status = "already recorded"
            else:
                await registry.record_conflict(
                    connection, channel=item.channel, address=item.address,
                    claimant_user_id=claimant, existing_owner_user_id=owner, detail=detail,
                )
                status = "recorded"
            conflicts.append({
                "channel": item.channel, "address": item.address, "claimant_user_id": claimant,
                "owner_user_id": owner, "detail": detail, "status": status,
            })

        existing_routes = {r.profile_slug: r for r in existing.routes}
        routes: List[Dict[str, Any]] = []
        wanted: Dict[str, Candidate] = {}
        for candidate in item.candidates:
            if candidate.owner_user_id in (owner, None):
                prior = wanted.get(candidate.profile)
                if prior is None or (candidate.route and not prior.route):
                    wanted[candidate.profile] = candidate
        for profile, candidate in sorted(wanted.items()):
            if profile in existing_routes:
                state = "on" if existing_routes[profile].enabled else "off"
                routes.append({"profile": profile, "status": "unchanged", "reason": f"route already exists ({state})"})
            elif not candidate.route:
                routes.append({"profile": profile, "status": "skipped", "reason": candidate.route_note})
            elif not await active(owner, profile):
                routes.append({"profile": profile, "status": "skipped",
                               "reason": f"owner {owner} is not an active member of profile {profile}"})
            else:
                await registry.set_route(
                    connection, source_id=existing.source_id, profile_slug=profile,
                    enabled=True, actor_user_id=owner, membership=already_checked,
                )
                routes.append({"profile": profile, "status": "added", "reason": candidate.found_in})
        sources.append({
            "source_id": existing.source_id,
            "channel": item.channel,
            "address": item.address,
            "owner_user_id": owner,
            "decided_by": decided_by,
            "assigned_to_install_owner": install,
            "action": action,
            "found_in": sorted({c.found_in for c in item.candidates}),
            "routes": routes,
        })
    return {"sources": sources, "conflicts": conflicts}


async def _plain_connection(dsn: str) -> Any:
    from tools.lazy_deps import ensure

    ensure("datastore.supabase")
    import asyncpg

    from hermes_cli import db_setup

    return await asyncpg.connect(
        dsn, server_settings={"search_path": registry.BOX_SCHEMA},
        connection_class=db_setup.connection_class(),
    )


async def migrate_sources(
    *,
    dsn: Optional[str] = None,
    dry_run: bool = False,
    paths: Optional[SourcePaths] = None,
    membership: Optional[Membership] = None,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Discover, decide and (unless ``dry_run``) write; returns the report.

    Everything is written in one transaction under an advisory lock. A dry run
    does the same work in a transaction that is rolled back (creating the box
    tables inside it when they do not exist yet), so its report is exactly
    what a real run would do and nothing is kept.
    """
    found = await discover(paths)
    plans = plan(found)
    target = dsn if dsn is not None else registry.box_dsn(config)
    if dry_run:
        connection = await _plain_connection(target)
    else:
        connection = await registry.connect_box(dsn=target)
    try:
        transaction = connection.transaction()
        await transaction.start()
        try:
            await connection.execute("SELECT pg_advisory_xact_lock($1)", _LOCK_KEY)
            if dry_run and not await registry._box_ready(connection):
                await registry.initialize_box(connection)
            applied = await apply_plans(connection, plans, membership=membership)
        except BaseException:
            await transaction.rollback()
            raise
        if dry_run:
            await transaction.rollback()
        else:
            await transaction.commit()
    finally:
        await connection.close()
    return {
        "dry_run": dry_run,
        "install_owner_user_id": found.install_owner_user_id,
        **applied,
        "skipped": found.skipped,
    }


# -- report -----------------------------------------------------------------------


def changed(report: Dict[str, Any]) -> int:
    """How many writes the run made (or a dry run would make)."""
    return (
        sum(1 for s in report["sources"] if s["action"] == "registered")
        + sum(1 for s in report["sources"] for r in s["routes"] if r["status"] == "added")
        + sum(1 for c in report["conflicts"] if c["status"] == "recorded")
    )


def format_report(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    verb = "Would migrate" if report["dry_run"] else "Migrated"
    lines.append(f"{verb} {len(report['sources'])} source(s); install owner: "
                 f"{report['install_owner_user_id'] or '(none)'}")
    for source in report["sources"]:
        flag = "  [assigned to install owner]" if source["assigned_to_install_owner"] else ""
        lines.append(f"- {source['channel']} {source['address']}: owner {source['owner_user_id']}"
                     f" ({source['decided_by']}){flag} — {source['action']}")
        for where in source["found_in"]:
            lines.append(f"    found in: {where}")
        for route in source["routes"]:
            lines.append(f"    route {route['profile']}: {route['status']} — {route['reason']}")
        if not source["routes"]:
            lines.append("    no routes")
    lines.append(f"Conflicts for the box owner to resolve: {len(report['conflicts'])}")
    for conflict in report["conflicts"]:
        lines.append(f"- {conflict['channel']} {conflict['address']}: {conflict['claimant_user_id']} "
                     f"also claims it (owner {conflict['owner_user_id']}) — {conflict['status']}")
        lines.append(f"    {conflict['detail']}")
    lines.append(f"Skipped: {len(report['skipped'])}")
    for item in report["skipped"]:
        lines.append(f"- {item['item']}: {item['reason']}")
    lines.append(("Would change" if report["dry_run"] else "Changed") + f" {changed(report)} row(s).")
    return "\n".join(lines)


def run_for_db_migrate(dsn: str, config: Optional[Dict[str, Any]] = None) -> str:
    """The ``hermes db migrate`` step: migrate and return a one-line summary.

    Raises on a database error (the step then shows as failed). Addresses stay
    out of the deploy log; ``hermes source migrate`` prints the full report.
    """
    report = asyncio.run(migrate_sources(dsn=dsn, config=config))
    return (
        f"{len(report['sources'])} source(s), {changed(report)} change(s), "
        f"{len(report['conflicts'])} conflict(s), {len(report['skipped'])} skipped"
    )


def source_migrate_command(args: argparse.Namespace) -> int:
    dsn: Optional[str] = None
    if getattr(args, "dsn_stdin", False):
        from hermes_cli.db_migrate import parse_dsn

        dsn = parse_dsn(sys.stdin.read())
        if not dsn:
            print("No database address on standard input "
                  "(expected HERMES_DB_ADMIN_URL=postgresql://...).", file=sys.stderr)
            return 1
    paths = SourcePaths(
        email_config=Path(args.email_config) if getattr(args, "email_config", None) else None,
        whatsapp_config=Path(args.whatsapp_config) if getattr(args, "whatsapp_config", None) else None,
    )
    try:
        report = asyncio.run(migrate_sources(dsn=dsn, dry_run=args.dry_run, paths=paths))
    except (RuntimeError, ValueError, OSError) as error:
        print(f"Source migration failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, default=str) if args.json else format_report(report))
    return 0


def add_migrate_parser(sub: argparse._SubParsersAction) -> argparse.ArgumentParser:
    """Add ``migrate`` to the ``hermes source`` sub-actions (see :mod:`hermes_cli.source_cli`)."""
    run = sub.add_parser(
        "migrate",
        help="Register today's mailboxes, WhatsApp numbers and Telegram bots; idempotent",
        description=(
            "Find every mailbox, WhatsApp number and Telegram bot configured on the "
            "box today, register each with one owner, route it to the profiles it "
            "is configured in, and record conflicting claims for the box owner. "
            "Safe to run again."
        ),
    )
    run.add_argument("--dry-run", action="store_true", help="show what would change; write nothing")
    run.add_argument("--json", action="store_true", help="print the report as JSON")
    run.add_argument("--dsn-stdin", action="store_true",
                     help="read the database address (HERMES_DB_ADMIN_URL=...) from standard input")
    run.add_argument("--email-config", help=f"email poller config (default: config.yaml, then {EMAIL_CONFIG_PATH})")
    run.add_argument("--whatsapp-config", help=f"WhatsApp config (default: {WHATSAPP_CONFIG_PATH})")
    run.set_defaults(func=source_migrate_command)
    return run
