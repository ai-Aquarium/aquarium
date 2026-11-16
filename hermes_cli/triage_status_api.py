"""``GET /api/triage/status`` — the signed-in person's triage setup (read-only).

Signed-in policy: every person sees only their own mailboxes, numbers and
calendars (see :mod:`hermes_cli.triage_status`). The route takes no
``profile`` parameter of its own, so ``?profile=`` is handled wholly by
``require_profile_scope``: it refuses a profile the caller isn't enrolled in
and otherwise holds that profile's scope (``HERMES_HOME``, credential store,
config) for the handler, with the caller resolved in that profile.

``/api/triage/layers*`` (FG-03 P3) serve the layered triage skills of the
scoped profile: built-in → the profile's template → the caller's own version.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from hermes_cli import triage_status
from hermes_cli.profile_route_scope import ProfileScope, require_profile_scope
from hermes_cli.route_roles import ADMIN

router = APIRouter(prefix="/api/triage", tags=["triage"])


async def _caller(request: Request):
    """The signed-in person; no multi-user datastore = the single-user owner."""
    from hermes_cli.wa_bridge_api import _OPERATOR
    from hermes_cli.web_server import _CommsNotConfigured, _comms_resolve_principal

    try:
        return await _comms_resolve_principal(request, allow_as=False)
    except _CommsNotConfigured:
        return _OPERATOR


async def _principal(request: Request, target: Optional[ProfileScope]):
    if isinstance(target, ProfileScope) and target.principal is not None:
        return target.principal
    return await _caller(request)


@router.get("/status")
async def get_triage_status(
    request: Request,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    principal = await _principal(request, target)
    result = await triage_status.triage_status(
        principal, install_owner=not isinstance(target, ProfileScope)
    )
    result["can_edit"] = triage_status.can_edit(principal)
    if isinstance(target, ProfileScope):
        name = target.entry.name
    else:
        # No scope switch: the hint (if any) names the acting profile.
        name = (request.query_params.get("profile") or "").strip() or None
    return {"profile": name, **result}


# Triage skill files are box-wide (the pipelines read them from
# ``triage.skills_dirs``): any signed-in person may read them and their
# history; only an owner or admin (in the addressed profile) may change them.


class SkillFileWrite(BaseModel):
    kind: str
    path: str
    content: str


def _file(kind: str, path: str):
    try:
        return triage_status.triage_file(kind, path)
    except triage_status.SkillFileError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/skill-file")
async def get_triage_skill_file(
    request: Request,
    kind: str,
    path: str,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    principal = await _principal(request, target)
    file = _file(kind, path)
    try:
        content = file.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"cannot read {file.name}") from exc
    return {
        "kind": kind,
        "name": file.name,
        "path": str(file),
        "content": content,
        "can_edit": triage_status.can_edit(principal),
    }


@router.get("/skill-file/history")
async def get_triage_skill_file_history(kind: str, path: str):
    file = _file(kind, path)
    return {"kind": kind, "path": str(file), "versions": triage_status.file_history(file)}


@router.put("/skill-file", dependencies=ADMIN)
async def put_triage_skill_file(body: SkillFileWrite, request: Request):
    from hermes_cli.skills_versions_api import acting_author

    file = _file(body.kind, body.path)
    author = await acting_author(request)
    try:
        version = triage_status.write_triage_file(file, body.content, author=author)
    except triage_status.SkillFileError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return {"ok": True, "path": str(file), "version": {k: v for k, v in version.items() if k != "content"}}



# -- FG-03 P3: layered triage skills per user-profile ---------------------------
#
# Three layers per kind (built-in → this profile's template → the caller's own
# version, see :mod:`hermes_cli.triage_skills`). The profile is the one
# ``require_profile_scope`` holds (``?profile=`` or the acting profile); the
# user layer is always the caller's own ``user_id`` there, never a parameter.
# Any member reads the built-in and template layers and their own; only the
# profile's owner/admins change the template (``can_edit_layer``).

LAYER_VIEWS = ("effective", "builtin", "template", "user")


class LayerFileWrite(BaseModel):
    kind: str
    layer: str
    key: str
    content: str


class LayerDisable(BaseModel):
    kind: str
    layer: str
    key: str
    disabled: bool


class LayerReset(BaseModel):
    kind: str
    key: Optional[str] = None


class LayerCareWrite(BaseModel):
    kind: str
    layer: str
    content: str


def _skills_call(fn, *args, **kwargs):
    from hermes_cli import triage_skills

    try:
        return fn(*args, **kwargs)
    except triage_skills.SkillFileError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    except ValueError as exc:
        # An id/key the folder helpers refuse (e.g. it would escape users/).
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _layers_home():
    from pathlib import Path

    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def _own_user_id(principal) -> Optional[str]:
    return str(getattr(principal, "user_id", "") or "").strip() or None


def _profile_name(request: Request, target: Optional[ProfileScope]) -> Optional[str]:
    if isinstance(target, ProfileScope):
        return target.entry.name
    return (request.query_params.get("profile") or "").strip() or None


def _require_layer_edit(layer: str, principal, user_id: Optional[str]) -> None:
    from hermes_cli import triage_skills
    from hermes_cli.route_roles import ADMIN_DENIED

    if layer not in triage_skills.EDITABLE_LAYERS:
        raise HTTPException(status_code=400, detail=f"layer {layer!r} is not editable")
    if layer == "user" and not user_id:
        raise HTTPException(status_code=400, detail="the user layer needs a signed-in person")
    if not triage_skills.can_edit_layer(layer, principal, user_id):
        raise HTTPException(status_code=403, detail=ADMIN_DENIED)


def _public_version(version: dict) -> dict:
    return {k: v for k, v in version.items() if k != "content"}


@router.get("/layers")
async def get_triage_layers(
    request: Request,
    kind: str,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills

    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    home = _layers_home()
    files = _skills_call(triage_skills.resolve, kind, home, user_id, with_content=False)
    care = _skills_call(triage_skills.care_section, kind, home, user_id)
    return {
        "profile": _profile_name(request, target),
        "kind": kind,
        "user_id": user_id,
        "files": [f.as_dict() for f in files],
        "care": {"key": triage_skills.CARE_KEY, **care},
        "can_edit_template": triage_skills.can_edit_layer("template", principal),
    }


@router.get("/layers/file")
async def get_triage_layer_file(
    request: Request,
    kind: str,
    key: str,
    layer: str = "effective",
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills

    if layer not in LAYER_VIEWS:
        raise HTTPException(status_code=400, detail=f"unknown layer: {layer!r}")
    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    home = _layers_home()
    _skills_call(triage_skills.validate_key, key)
    view = _skills_call(triage_skills.resolve, kind, home, user_id)
    entry = next((f for f in view if f.key == key), None)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"no triage skill {key!r} for {kind}")
    if layer == "effective":
        shown, content = entry.layer, entry.content
    else:
        if layer == "user" and not user_id:
            raise HTTPException(status_code=400, detail="the user layer needs a signed-in person")
        shown = layer
        content = _skills_call(triage_skills.layer_content, kind, layer, key, home, user_id)
    return {
        "kind": kind,
        "key": key,
        "layer": shown,
        "requested_layer": layer,
        "state": entry.layers_present.get(layer) if layer != "effective" else (
            "disabled" if entry.disabled else "content"
        ),
        "disabled": entry.disabled,
        "layers": dict(entry.layers_present),
        "content": content,
        "can_edit_template": triage_skills.can_edit_layer("template", principal),
    }


@router.get("/layers/diff")
async def get_triage_layer_diff(
    request: Request,
    kind: str,
    key: str,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills

    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    _skills_call(triage_skills.validate_key, key)
    return {"kind": kind, **_skills_call(triage_skills.diff, kind, key, _layers_home(), user_id)}


@router.get("/layers/history")
async def get_triage_layer_history(
    request: Request,
    kind: str,
    key: str,
    layer: str,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills

    if layer not in triage_skills.EDITABLE_LAYERS:
        raise HTTPException(status_code=400, detail=f"layer {layer!r} has no history")
    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    if layer == "user" and not user_id:
        raise HTTPException(status_code=400, detail="the user layer needs a signed-in person")
    versions = _skills_call(triage_skills.history, kind, layer, key, _layers_home(), user_id)
    return {"kind": kind, "key": key, "layer": layer, "versions": versions}


@router.put("/layers/file")
async def put_triage_layer_file(
    body: LayerFileWrite,
    request: Request,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills
    from hermes_cli.skills_versions_api import acting_author

    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    _require_layer_edit(body.layer, principal, user_id)
    author = await acting_author(request)
    version = _skills_call(
        triage_skills.write_file, body.kind, body.layer, body.key, body.content,
        home=_layers_home(), user_id=user_id, author=author,
    )
    return {"ok": True, "kind": body.kind, "layer": body.layer, "key": body.key,
            "version": _public_version(version)}


@router.post("/layers/disable")
async def post_triage_layer_disable(
    body: LayerDisable,
    request: Request,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills
    from hermes_cli.skills_versions_api import acting_author

    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    _require_layer_edit(body.layer, principal, user_id)
    author = await acting_author(request)
    result = _skills_call(
        triage_skills.set_disabled, body.kind, body.layer, body.key, body.disabled,
        home=_layers_home(), user_id=user_id, author=author,
    )
    return {"ok": True, "kind": body.kind, "layer": body.layer, "key": body.key,
            "disabled": body.disabled, "version": _public_version(result)}


@router.post("/layers/reset")
async def post_triage_layer_reset(
    body: LayerReset,
    request: Request,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills
    from hermes_cli.skills_versions_api import acting_author

    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    _require_layer_edit("user", principal, user_id)
    author = await acting_author(request)
    home = _layers_home()
    if body.key is None:
        _skills_call(triage_skills.validate_kind, body.kind)
        keys = _skills_call(triage_skills.reset_all, body.kind, home=home, user_id=user_id, author=author)
    else:
        result = _skills_call(
            triage_skills.reset_file, body.kind, body.key, home=home, user_id=user_id, author=author,
        )
        keys = [] if result.get("noop") else [body.key]
    return {"ok": True, "kind": body.kind, "reset": keys}


@router.put("/layers/care")
async def put_triage_layer_care(
    body: LayerCareWrite,
    request: Request,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    from hermes_cli import triage_skills
    from hermes_cli.skills_versions_api import acting_author

    principal = await _principal(request, target)
    user_id = _own_user_id(principal)
    _require_layer_edit(body.layer, principal, user_id)
    author = await acting_author(request)
    version = _skills_call(
        triage_skills.write_care, body.kind, body.content, layer=body.layer,
        home=_layers_home(), user_id=user_id, author=author,
    )
    care = _skills_call(triage_skills.care_section, body.kind, _layers_home(), user_id)
    return {"ok": True, "kind": body.kind, "layer": body.layer,
            "care": {"key": triage_skills.CARE_KEY, **care}, "version": _public_version(version)}
