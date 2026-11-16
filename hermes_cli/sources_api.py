"""FG-03 P2: the caller's incoming sources and where they route (``/api/sources``).

Each source (mailbox, WhatsApp number, Telegram bot) has one owner; every
write is the owner's own, except transfer (box owner/admin). Listing every
source on the box (``?all=1``) is box owner/admin only. The store is
:mod:`hermes_cli.source_registry`; no secret ever passes through here
(``credential_ref`` is a pointer).
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from hermes_cli import source_registry as registry

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
