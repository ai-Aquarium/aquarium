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

from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from hermes_cli import source_registry as registry
from hermes_cli import triage_agent, triage_router

router = APIRouter(prefix="/api/sources")


class RegisterBody(BaseModel):
    channel: str
    address: str
    display: Optional[str] = None
    credential_ref: Optional[dict[str, Any]] = None


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

    return {
        "sources": await _with_box(run),
        "profiles": await registry.active_profiles_for(user_id),
        "is_box_admin": box_admin,
    }


@router.post("")
async def register(request: Request, body: RegisterBody):
    principal = await _caller(request)

    async def run(connection):
        source = await registry.register_source(
            connection,
            channel=body.channel,
            address=body.address,
            owner_user_id=principal.user_id,
            display=body.display,
            credential_ref=body.credential_ref,
        )
        return {"source": source.as_dict()}

    return await _with_box(run)


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
