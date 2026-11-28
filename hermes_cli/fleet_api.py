"""Settings → Fleet (agent-home, owner only). The boxes this server manages.

The whole feature is config-gated: it exists only where ``/etc/aquarium/fleet.json``
is present — that file names the managed boxes and the SSH key to reach them, lives
root:root 0600, and is never part of a release. On every other server the helper
answers ``{"available": false}`` and the Settings tile stays hidden.

The work runs as root in ``/usr/local/sbin/aquarium fleet <verb>`` (installed from
``deploy/aquarium.py``; ``deploy/sudoers.d/aquarium-fleet`` allows exactly the verbs
probe, status, job and switch). ``switch`` hands the work to a transient systemd unit on the
target box, so it keeps going while this dashboard restarts. This router checks the
owner role, re-checks the owner's own password for a switch, and scrubs helper text
before it leaves the server — hosts, key paths and secrets never reach the page.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import re
import subprocess
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from hermes_cli.route_roles import OWNER

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fleet")

#: Root-owned install of deploy/aquarium.py; the sudoers rule names it.
_HELPER = "/usr/local/sbin/aquarium"
_UNAVAILABLE = "Fleet isn't set up on this server."
#: Absolute paths (two or more segments) in helper text the browser will see.
_PATH_RE = re.compile(r"(?<![\w.:/-])/(?:[\w.@+-]+/)+[\w.@+-]*")
_SECRETISH_RE = re.compile(r"(?i)\b(password|secret|token|key)=\S+")
_BOX_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")


class SwitchBody(BaseModel):
    box: str = Field(min_length=1, max_length=31)
    layout: str = Field(min_length=3, max_length=10)
    password: str = Field(min_length=1, max_length=512)


def _helper_argv(verb: str) -> List[str]:
    return ["sudo", "-n", _HELPER, "fleet", verb]


def _call(verb: str, payload: Optional[Dict[str, Any]] = None, timeout: float = 120) -> Dict[str, Any]:
    """Run one helper verb; return its JSON answer (``{"ok": False, ...}`` on failure)."""
    try:
        proc = subprocess.run(
            _helper_argv(verb),
            input=json.dumps(payload).encode() if payload is not None else b"",
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return {"ok": False, "unavailable": True, "error": _UNAVAILABLE}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "The server took too long to answer. Try again."}
    for line in reversed(proc.stdout.decode(errors="replace").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                answer = json.loads(line)
            except ValueError:
                break
            return answer if isinstance(answer, dict) else {"ok": False, "error": _UNAVAILABLE}
    # No JSON: sudo refused (rule not installed) or an older helper without `fleet`.
    return {"ok": False, "unavailable": True, "error": _UNAVAILABLE}


# --------------------------------------------------------------------------- shaping


def scrub(text: Any, limit: int = 400) -> str:
    """Helper text for the browser: no filesystem paths, nothing that looks like a secret."""
    out = _PATH_RE.sub("…", str(text or ""))
    out = _SECRETISH_RE.sub(lambda m: f"{m.group(1)}=…", out)
    return out[:limit]


def _installed_view(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    layout = raw.get("layout")
    return {
        "layout": layout if layout in ("release", "git") else None,
        "version": scrub(raw.get("version"), 40) or None,
        "label": scrub(raw.get("label"), 80) or None,
        "commit": scrub(raw.get("commit"), 40) or None,
        "channel": raw.get("channel") if raw.get("channel") in ("stable", "beta") else None,
        "installed_at": raw.get("installed_at") or None,
    }


def _box_view(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict) or not _BOX_RE.match(str(raw.get("name") or "")):
        return None
    return {
        "name": str(raw["name"]),
        "label": scrub(raw.get("label"), 80) or raw["name"],
        "self": bool(raw.get("self")),
        "reachable": bool(raw.get("reachable")),
        "installed": _installed_view(raw.get("installed")),
        "job": _job_view(raw.get("job")),
        "switch": _switch_view(raw.get("switch")),
        "error": scrub(raw.get("error")) or None,
    }


def _job_view(raw: Any) -> Optional[Dict[str, Any]]:
    """An upgrade/rollback job running on the box itself."""
    if not isinstance(raw, dict):
        return None
    return {"id": scrub(raw.get("id"), 40) or None,
            "phase": scrub(raw.get("phase"), 40) or None,
            "result": scrub(raw.get("result"), 40) or None,
            "to": scrub(raw.get("to"), 80) or None,
            "seconds": raw.get("seconds") if isinstance(raw.get("seconds"), (int, float)) else None}


def _switch_view(raw: Any) -> Optional[Dict[str, Any]]:
    """A layout switch this fleet started, with the unit's state and log tail."""
    if not isinstance(raw, dict):
        return None
    state = raw.get("state")
    return {"id": scrub(raw.get("id"), 40) or None,
            "to": raw.get("to") if raw.get("to") in ("git", "release") else None,
            "by": scrub(raw.get("by"), 80) or None,
            "started": raw.get("started") or None,
            "finished": raw.get("finished") or None,
            "state": state if state in ("running", "ok", "failed") else "running",
            "active": scrub(raw.get("active"), 40) or None,
            "log": [scrub(line, 300) for line in (raw.get("log") or [])][-60:]}


def status_view(raw: Dict[str, Any]) -> Dict[str, Any]:
    """What the page needs from ``fleet status``."""
    if raw.get("unavailable"):
        return {"available": False, "error": _UNAVAILABLE}
    if not raw.get("ok"):
        return {"available": False, "error": scrub(raw.get("error")) or _UNAVAILABLE}
    if not raw.get("available"):
        return {"available": False}
    boxes = [b for b in (_box_view(r) for r in raw.get("boxes") or []) if b]
    return {"available": True, "boxes": boxes}


def jobs_view(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Light poll for in-flight switches: ``fleet job`` keyed by box name."""
    if raw.get("unavailable") or not raw.get("ok"):
        return {"available": False, "error": scrub(raw.get("error")) or _UNAVAILABLE}
    if not raw.get("available"):
        return {"available": False}
    jobs = {name: _switch_view(job) for name, job in (raw.get("jobs") or {}).items()
            if isinstance(name, str) and _BOX_RE.match(name) and job}
    return {"available": True, "jobs": jobs}


def _fail(answer: Dict[str, Any]) -> HTTPException:
    if answer.get("unavailable"):
        return HTTPException(503, _UNAVAILABLE)
    return HTTPException(400, scrub(answer.get("error")) or "That did not work. Try again.")


# --------------------------------------------------------------------------- password re-check


async def _confirm_password(request: Request, password: str) -> str:
    """Re-check the signed-in owner's own password; return the name for the history.

    Uses the same ``dashboard_auth`` provider the login used (Supabase's password grant
    on agent-home installs), with the login page's per-IP attempt limit. A caller with
    no interactive password login (operator token, OAuth-only) is refused: switches from
    there go through ``sudo aquarium fleet switch`` on the server.
    """
    from hermes_cli import web_server as ws
    from hermes_cli.dashboard_auth import get_provider
    from hermes_cli.dashboard_auth.base import InvalidCredentialsError, ProviderError
    from hermes_cli.dashboard_auth.routes import _client_ip, _password_rate_limited

    session = getattr(request.state, "session", None)
    if session is None or not getattr(session, "email", ""):
        raise HTTPException(403, "Sign in with your password to switch a box.")
    if _password_rate_limited(_client_ip(request)):
        raise HTTPException(429, "Too many tries. Wait a minute and try again.")
    provider = get_provider(session.provider)
    if provider is None or not getattr(provider, "supports_password", False):
        raise HTTPException(403, "Your sign-in has no password to confirm with.")
    try:
        checked = await asyncio.to_thread(functools.partial(
            provider.complete_password_login, username=session.email, password=password))
    except InvalidCredentialsError:
        _log.warning("fleet switch: password re-check failed for %s", session.user_id)
        raise HTTPException(400, "That password is not right.")
    except (ProviderError, NotImplementedError):
        raise HTTPException(503, "Your password could not be checked right now. Try again.")
    if getattr(checked, "user_id", None) != session.user_id:
        raise HTTPException(400, "That password is not right.")
    try:
        principal = await ws._comms_resolve_principal(request)
        name = str(getattr(principal, "display", "") or "")
    except Exception:  # noqa: BLE001 — the name is only a label for the history
        name = ""
    return (name or session.display_name or session.email)[:80]


# --------------------------------------------------------------------------- routes


@router.get("/available", dependencies=OWNER)
async def fleet_available():
    """The Settings index's cheap check — no SSH, just "does this box manage a fleet"."""
    raw = await asyncio.to_thread(_call, "probe")
    return {"available": bool(raw.get("ok") and raw.get("available"))}


@router.get("", dependencies=OWNER)
async def fleet_status():
    """Every managed box: what runs where, and any layout switch in flight."""
    raw = await asyncio.to_thread(_call, "status")
    return status_view(raw)


@router.get("/job", dependencies=OWNER)
async def fleet_job():
    """Light poll for the progress state of in-flight layout switches."""
    raw = await asyncio.to_thread(_call, "job")
    return jobs_view(raw)


@router.post("/switch", status_code=202, dependencies=OWNER)
async def fleet_switch(request: Request, body: SwitchBody):
    """Move one box between the git layout (direct deploy) and the release layout
    (software upgrade). The work runs detached on the target box."""
    if not _BOX_RE.match(body.box):
        raise HTTPException(400, "Unknown box.")
    if body.layout not in ("git", "release"):
        raise HTTPException(400, "Pick 'direct deploy' or 'software upgrade'.")
    by = await _confirm_password(request, body.password)
    answer = await asyncio.to_thread(
        _call, "switch", {"box": body.box, "layout": body.layout, "by": by}, 90)
    if not answer.get("ok"):
        raise _fail(answer)
    return {"started": True, "box": body.box, "layout": body.layout,
            "job": _switch_view(answer.get("job"))}
