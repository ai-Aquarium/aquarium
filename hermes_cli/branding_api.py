"""Box branding: the entity name and logo shown on the sign-in page and top bar.

Each box is one entity's deployment, so its owner names it and may upload a
logo. ``branding.name`` lives in the default profile's config.yaml; the logo
is a file under the default profile's ``HERMES_HOME/branding/`` with its type
and a content hash recorded in ``branding.logo``. With no logo the UI draws a
monogram from the name; with no name it keeps the Aquarium mark.

The two reads are public because the sign-in page needs them before anyone is
signed in; they expose only what that page shows. Writes are owner-only and
live under ``/api/settings/branding`` because the public allowlist matches a
path for every method.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import unicodedata
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from hermes_cli.route_roles import OWNER

router = APIRouter()

NAME_MAX = 60
LOGO_MAX_BYTES = 1024 * 1024
LOGO_DIR = "branding"
LOGO_FILE = "logo"
_BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")

# Raster formats only: an SVG can carry script, and this file is served
# without sign-in.
_SIGNATURES = (
    ("image/png", lambda b: b.startswith(b"\x89PNG\r\n\x1a\n")),
    ("image/jpeg", lambda b: b.startswith(b"\xff\xd8\xff")),
    ("image/gif", lambda b: b[:6] in (b"GIF87a", b"GIF89a")),
    ("image/webp", lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP"),
)


def _section(config: Dict[str, Any]) -> Dict[str, Any]:
    branding = config.get("branding")
    return branding if isinstance(branding, dict) else {}


def _writable_section(config: Dict[str, Any]) -> Dict[str, Any]:
    branding = config.get("branding")
    if not isinstance(branding, dict):
        branding = config["branding"] = {}
    return branding


def normalize_name(value: Any) -> str:
    """The trimmed name without control characters; ``""`` means unset."""
    if not isinstance(value, str):
        raise ValueError("name must be a string.")
    name = "".join(
        c for c in value if unicodedata.category(c) != "Cc" and c not in _BIDI_CONTROLS
    ).strip()
    if len(name) > NAME_MAX:
        raise ValueError(f"name must be at most {NAME_MAX} characters.")
    return name


def entity_name(config: Dict[str, Any]) -> Optional[str]:
    try:
        return normalize_name(_section(config).get("name")) or None
    except ValueError:
        return None


def set_entity_name(config: Dict[str, Any], value: Any) -> Optional[str]:
    name = normalize_name(value)
    branding = _writable_section(config)
    if name:
        branding["name"] = name
    else:
        branding.pop("name", None)
    return name or None


def sniff_image(data: bytes) -> Optional[str]:
    """The MIME type of a supported raster image, or None."""
    for mime, matches in _SIGNATURES:
        if matches(data):
            return mime
    return None


def _logo_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / LOGO_DIR / LOGO_FILE


def logo_meta(config: Dict[str, Any]) -> Optional[Dict[str, str]]:
    logo = _section(config).get("logo")
    if not isinstance(logo, dict):
        return None
    mime, version = logo.get("content_type"), logo.get("version")
    if not isinstance(mime, str) or not isinstance(version, str):
        return None
    if not any(mime == m for m, _ in _SIGNATURES) or not _logo_path().is_file():
        return None
    return {"content_type": mime, "version": version}


def branding(config: Dict[str, Any]) -> Dict[str, Any]:
    return {"name": entity_name(config), "logo": logo_meta(config)}


def _default_scope():
    from hermes_cli import web_server as ws

    return ws._profile_scope("default")


def read_branding() -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    try:
        with _default_scope():
            return branding(ws.load_config())
    except Exception:
        return {"name": None, "logo": None}


@router.get("/api/branding")
async def get_branding():
    """The box's entity name and logo metadata. Public (the sign-in page reads it)."""
    return read_branding()


@router.get("/api/branding/logo")
async def get_branding_logo():
    """The uploaded logo's bytes. Public; 404 when none is set."""
    from hermes_cli import web_server as ws

    with _default_scope():
        meta = logo_meta(ws.load_config())
        data = _logo_path().read_bytes() if meta else None
    if meta is None or data is None:
        raise HTTPException(status_code=404, detail="No logo is set.")
    return Response(
        content=data,
        media_type=meta["content_type"],
        headers={
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'",
        },
    )


class BrandingUpdate(BaseModel):
    name: Any = None


@router.put("/api/settings/branding", dependencies=OWNER)
async def put_branding(body: BrandingUpdate, request: Request):
    """Set (or with ``""`` clear) the entity name. Owner only."""
    from hermes_cli import web_server as ws

    if "name" not in body.model_fields_set:
        raise HTTPException(status_code=400, detail="Give name.")
    with _default_scope():
        config = ws.load_config()
        try:
            set_entity_name(config, body.name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        ws.save_config(config)
        return branding(config)


class LogoUpload(BaseModel):
    data: Any = None


@router.put("/api/settings/branding/logo", dependencies=OWNER)
async def put_branding_logo(body: LogoUpload, request: Request):
    """Store a PNG, JPEG, GIF or WebP logo (base64 ``data``, ≤ 1 MB). Owner only."""
    from hermes_cli import web_server as ws

    if not isinstance(body.data, str) or not body.data:
        raise HTTPException(status_code=400, detail="Give the image as base64 data.")
    try:
        raw = base64.b64decode(body.data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="data is not valid base64.") from exc
    if len(raw) > LOGO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="The logo must be 1 MB or smaller.")
    mime = sniff_image(raw)
    if mime is None:
        raise HTTPException(status_code=400, detail="Use a PNG, JPEG, GIF or WebP image.")
    with _default_scope():
        path = _logo_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(path)
        config = ws.load_config()
        _writable_section(config)["logo"] = {
            "content_type": mime,
            "version": hashlib.sha256(raw).hexdigest()[:16],
        }
        ws.save_config(config)
        return branding(config)


@router.delete("/api/settings/branding/logo", dependencies=OWNER)
async def delete_branding_logo(request: Request):
    """Remove the logo so the monogram shows again. Owner only."""
    from hermes_cli import web_server as ws

    with _default_scope():
        config = ws.load_config()
        _writable_section(config).pop("logo", None)
        ws.save_config(config)
        _logo_path().unlink(missing_ok=True)
        return branding(config)
