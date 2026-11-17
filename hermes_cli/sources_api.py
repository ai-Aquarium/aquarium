"""FG-03 P2: the caller's incoming sources and where they route (``/api/sources``).

Each source (mailbox, WhatsApp number, Telegram bot) has one owner; every
write is the owner's own, except transfer (box owner/admin). Listing every
source on the box (``?all=1``) is box owner/admin only. The store is
:mod:`hermes_cli.source_registry`; no secret ever passes through here
(``credential_ref`` is a pointer). Routing decisions (FG-03 P4) are the
owner's own; ``?all=1`` (box owner/admin) is for support. Pausing a source
(``PATCH``) is its owner's or the box admin's; settling a claim conflict is
the box admin's.
"""

from __future__ import annotations

import re
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from hermes_cli import source_registry as registry
from hermes_cli import triage_agent, triage_router

router = APIRouter(prefix="/api/sources")


class RegisterBody(BaseModel):
    channel: str
    #: Required for email. WhatsApp / Telegram may leave it out and name the
    #: caller's own credential instead (see :func:`_from_own_credential`).
    address: Optional[str] = None
    display: Optional[str] = None
    credential_ref: Optional[dict[str, Any]] = None


#: Credential kinds whose address the server reads itself, and their channel.
_DERIVED = {"wa-bridge": "whatsapp", "telegram-bot": "telegram"}
_BRIDGE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
_TAKEN = (
    "This {label} is already registered to another user. "
    "Ask the box owner if you think it should be yours."
)


async def _from_own_credential(principal, channel: str, ref: Optional[dict[str, Any]]):
    """``(address, credential_ref, display)`` read from the caller's OWN credential.

    The agent-home wizard only sees masked WhatsApp numbers and no bot ids, so
    for ``{"kind": "wa-bridge", "bridge": <name>}`` (a bridge the caller added
    in this profile) and ``{"kind": "telegram-bot"[, "name"]}`` (their saved
    bot) the address comes from the bridge's linked session / the bot token
    here. Someone else's credential is refused; neither the number nor the
    token is ever put in an error.
    """
    from hermes_cli.profiles import get_active_profile_name

    kind = str((ref or {}).get("kind") or "")
    expected = _DERIVED.get(kind)
    if expected is None:
        raise HTTPException(
            status_code=400,
            detail="address is required, or a credential_ref of kind wa-bridge or telegram-bot",
        )
    if channel != expected:
        raise HTTPException(status_code=400, detail=f"A {kind} credential is a {expected} source.")
    profile = get_active_profile_name()
    if kind == "wa-bridge":
        return await _own_bridge(principal, profile, ref or {})
    return await _own_bot(principal, profile, ref or {})


async def _own_bridge(principal, profile: str, ref: dict[str, Any]):
    from hermes_cli import wa_bridge_owners as owners

    name = str(ref.get("bridge") or "").strip().lower()
    if not _BRIDGE_NAME.fullmatch(name):
        raise HTTPException(status_code=400, detail="credential_ref.bridge must be a bridge name")
    person = owners.bridge_person(name)
    if person is None:
        if not owners.session_dir(name).is_dir():
            raise HTTPException(status_code=404, detail="No such WhatsApp bridge.")
        # A bridge nobody recorded belongs to the install owner (wa_bridge_owners).
        from hermes_cli.access import PrincipalStore
        from hermes_cli.datastore import get_store

        install = await PrincipalStore(get_store("supabase-app", "prod")).get_owner()
        person = install.user_id if install is not None else None
    if person != principal.user_id:
        raise HTTPException(
            status_code=403, detail="Only the person who added this WhatsApp bridge can register it."
        )
    number = owners.own_number(name)
    if number is None:
        raise HTTPException(
            status_code=409, detail="This WhatsApp bridge is not linked to a phone yet."
        )
    out: dict[str, Any] = {"profile": profile, "kind": "wa-bridge", "bridge": name,
                           "owner_user_id": principal.user_id}
    port = owners.recorded_port(name)
    if port:
        out["port"] = port
    return number, out, name


async def _own_bot(principal, profile: str, ref: dict[str, Any]):
    from agent.secret_scope import load_env_file
    from hermes_cli.credentials_api import _store
    from hermes_cli.telegram_bot_api import KIND, NAME, PROVIDER, bot_id_of
    from hermes_constants import get_hermes_home

    name = str(ref.get("name") or NAME).strip()
    cred = await _store().get(principal, PROVIDER, name)
    if cred is None or cred.kind != KIND:
        raise HTTPException(status_code=404, detail="You have no Telegram bot saved.")
    if cred.owner_user_id != principal.user_id:
        raise HTTPException(status_code=403, detail="Only the bot's owner can register it.")
    token = str((cred.payload or {}).get("token") or "")
    bot_id = bot_id_of(token) if token else ""
    if not bot_id.isdigit():
        raise HTTPException(status_code=409, detail="This Telegram bot has no valid token saved.")
    install = str(load_env_file(get_hermes_home() / ".env").get("TELEGRAM_BOT_TOKEN") or "")
    if install and bot_id_of(install) == bot_id:
        raise HTTPException(
            status_code=409,
            detail="This is the profile's own Telegram bot, not one person's source.",
        )
    username = (cred.payload or {}).get("bot_username")
    out = {"profile": profile, "kind": KIND, "provider": PROVIDER, "name": name,
           "owner_user_id": principal.user_id}
    return bot_id, out, f"@{username}" if username else None


class RouteBody(BaseModel):
    enabled: bool


class TransferBody(BaseModel):
    new_owner_user_id: str = Field(min_length=1)


class PatchBody(BaseModel):
    enabled: Optional[bool] = None
    display: Optional[str] = None


class ResolveBody(BaseModel):
    action: Literal["keep", "transfer"]


async def _caller(request: Request):
    from hermes_cli.credentials_api import _principal

    return await _principal(request, allow_as=False)


def _http(error: registry.SourceRegistryError) -> HTTPException:
    return HTTPException(status_code=error.status, detail=str(error))


async def _with_box(fn):
    try:
        connection = await registry.connect_box()
    except registry.SourceRegistryError as error:
        raise _http(error) from error
    try:
        return await fn(connection)
    except registry.SourceRegistryError as error:
        raise _http(error) from error
    finally:
        await connection.close()


@router.get("")
async def list_my_sources(request: Request, all: bool = False):
    """The caller's sources with routes, plus the profiles they may route to."""
    principal = await _caller(request)
    user_id = principal.user_id
    box_admin = await registry.is_box_admin(user_id)
    if all and not box_admin:
        raise HTTPException(status_code=403, detail="Only the box owner or an admin can list every source.")

    async def run(connection):
        sources = await registry.list_sources(
            connection, owner_user_id=None if all else user_id
        )
        return [s.as_dict() for s in sources]

    roles = await registry.active_profile_roles(user_id)
    return {
        "sources": await _with_box(run),
        "profiles": list(roles),
        #: The caller's own role in each of those profiles (never anyone else's).
        "profile_roles": roles,
        "is_box_admin": box_admin,
    }


@router.post("")
async def register(request: Request, body: RegisterBody):
    """Register a source to the caller.

    Email: ``{channel, address, display?, credential_ref?}``. WhatsApp /
    Telegram may instead send ``{channel, credential_ref: {kind: "wa-bridge",
    bridge}}`` or ``{channel, credential_ref: {kind: "telegram-bot"}}`` with
    no address: it is read from the caller's own credential.
    """
    principal = await _caller(request)
    address, ref, display, derived = body.address, body.credential_ref, body.display, False
    if not (address or "").strip():
        try:
            channel = registry.normalize_channel(body.channel)
        except registry.SourceRegistryError as error:
            raise _http(error) from error
        address, ref, default_display = await _from_own_credential(principal, channel, ref)
        display, derived = display or default_display, True

    async def run(connection):
        try:
            source = await registry.register_source(
                connection,
                channel=body.channel,
                address=address,
                owner_user_id=principal.user_id,
                display=display,
                credential_ref=ref,
            )
        except registry.SourceOwnedByAnotherUser as error:
            return error
        return {"source": source.as_dict()}

    result = await _with_box(run)
    if not isinstance(result, registry.SourceOwnedByAnotherUser):
        return result
    if derived:
        label = "WhatsApp number" if result.channel == "whatsapp" else "Telegram bot"
        detail = _TAKEN.format(label=label)
    else:
        detail = str(result)
    # The claim screen names the current owner by display name only.
    owner = await registry.display_name_for(result.owner_user_id)
    return JSONResponse(status_code=409, content={"detail": detail, "owner_display": owner})


@router.put("/{source_id}/routes/{profile}")
async def put_route(request: Request, source_id: str, profile: str, body: RouteBody):
    principal = await _caller(request)

    async def run(connection):
        route = await registry.set_route(
            connection,
            source_id=source_id,
            profile_slug=profile,
            enabled=body.enabled,
            actor_user_id=principal.user_id,
        )
        return {"route": route.as_dict()}

    return await _with_box(run)


@router.delete("/{source_id}")
async def delete_source(request: Request, source_id: str):
    principal = await _caller(request)

    async def run(connection):
        source = await registry.get_source(connection, source_id)
        if source is None:
            raise registry.SourceNotFound(f"No such source: {source_id}")
        if source.owner_user_id != principal.user_id:
            raise registry.SourcePermissionError("Only the source's owner can remove it.")
        deleted = await registry.remove_source(
            connection, source_id=source_id, actor_user_id=principal.user_id
        )
        return {"deleted": deleted}

    return await _with_box(run)


@router.patch("/{source_id}")
async def patch_source(request: Request, source_id: str, body: PatchBody):
    """Pause/resume a source or relabel it (its owner, or box owner/admin).

    Omitted fields stay as they are; ``display: null`` clears the label. A
    disabled source keeps its routes, but no poller, bridge or bot reads it.
    """
    principal = await _caller(request)
    given = body.model_fields_set

    async def run(connection):
        source = await registry.update_source(
            connection,
            source_id=source_id,
            actor_user_id=principal.user_id,
            enabled=body.enabled if "enabled" in given else None,
            display=body.display if "display" in given else registry.UNSET,
        )
        return {"source": source.as_dict()}

    return await _with_box(run)


@router.post("/{source_id}/transfer")
async def transfer(request: Request, source_id: str, body: TransferBody):
    """Give a source to another person (box owner/admin; routes are dropped)."""
    principal = await _caller(request)

    async def run(connection):
        source = await registry.transfer_source(
            connection,
            source_id=source_id,
            new_owner_user_id=body.new_owner_user_id,
            actor_user_id=principal.user_id,
        )
        return {"source": source.as_dict()}

    return await _with_box(run)


@router.get("/conflicts")
async def conflicts(request: Request, all: bool = False):
    """Refused/disputed claims the caller is part of (``?all=1``: box admin, everyone's)."""
    principal = await _caller(request)
    user_id = principal.user_id
    if all and not await registry.is_box_admin(user_id):
        raise HTTPException(status_code=403, detail="Only the box owner or an admin can list every conflict.")

    async def run(connection):
        rows = await registry.list_conflicts(
            connection, user_id=None if all else user_id
        )
        return [c.as_dict() for c in rows]

    return {"conflicts": await _with_box(run)}


@router.post("/conflicts/{conflict_id}/resolve")
async def resolve_conflict(request: Request, conflict_id: int, body: ResolveBody):
    """Settle a claim conflict (box owner/admin): ``keep`` or ``transfer`` to the claimant."""
    principal = await _caller(request)

    async def run(connection):
        conflict = await registry.settle_conflict(
            connection,
            conflict_id=conflict_id,
            action=body.action,
            actor_user_id=principal.user_id,
        )
        return {"conflict": conflict.as_dict()}

    return await _with_box(run)


@router.get("/decisions")
async def decisions(
    request: Request,
    source_id: Optional[str] = None,
    batch_id: Optional[str] = None,
    limit: int = 50,
    all: bool = False,
):
    """Why each of the caller's batches went to which profile (newest first).

    Only the caller's own decisions; ``?all=1`` lists everyone's for the box
    owner/admin. No batch text is stored, only the router's reasons.
    """
    principal = await _caller(request)
    user_id = principal.user_id
    if all and not await registry.is_box_admin(user_id):
        raise HTTPException(status_code=403, detail="Only the box owner or an admin can list every decision.")

    async def run(connection):
        rows = await triage_router.list_decisions(
            connection,
            owner_user_id=None if all else user_id,
            source_id=source_id or None,
            batch_id=batch_id or None,
            limit=limit,
        )
        return [d.as_dict() for d in rows]

    return {"decisions": await _with_box(run)}


@router.get("/comparisons")
async def comparisons(
    request: Request,
    source_id: Optional[str] = None,
    batch_id: Optional[str] = None,
    limit: int = 50,
    all: bool = False,
):
    """Today's triage vs each picked profile's agent, per batch (newest first).

    Only the caller's own batches; ``?all=1`` lists everyone's for the box
    owner/admin. No batch text is stored, only the two triage results.
    """
    principal = await _caller(request)
    user_id = principal.user_id
    if all and not await registry.is_box_admin(user_id):
        raise HTTPException(status_code=403, detail="Only the box owner or an admin can list every comparison.")

    async def run(connection):
        return await triage_agent.list_comparisons(
            connection,
            owner_user_id=None if all else user_id,
            source_id=source_id or None,
            batch_id=batch_id or None,
            limit=limit,
        )

    return {"comparisons": await _with_box(run)}
