"""A project card's outgoing message: the worker proposes, a person sends.

A card worker has no ``send_message`` (by design), so a playbook step that
drafts an invoice cannot email or WhatsApp it. Instead it *proposes* the
message with ``hermes projects propose-send``: the full message — channel,
recipient, sending account, subject, body and an optional file from the
card's workspace — is stored on the card as a card approval
(``task_approvals``, key ``send:<id>``, detail = the message as JSON). It
shows wherever the card's approvals already render (the project's Needs you,
the board, the card), and nothing leaves until a person approves it there.

Same principle as To-dos (:mod:`hermes_cli.todo_outbound`): the system may
propose; only the user may send.

- What is sent is what was shown: the body comes from the approval row,
  never from the request that approves it, and the attachment is a copy
  taken when proposed (:func:`kanban_db.outbound_root`) whose SHA-256 is
  checked again before sending.
- Single use: the pending → approved transition happens once, and a
  ``outbound_sent`` event on the card refuses any second delivery.
- Delivery goes through the shared egress
  (:func:`todo_outbound.deliver_message`), account-routed, so it leaves from
  the company account the proposal named.
- Deny records the refusal; "revise" denies this draft and puts the note on
  the card so the next worker run drafts a new proposal. A failed send puts
  the approval back to pending so it can be retried or denied.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Optional

from hermes_cli import kanban_db, todo_outbound

KEY_PREFIX = "send:"
DETAIL_KIND = "outbound_send"
CHANNELS = ("email", "whatsapp")
#: Per-file cap for a proposed attachment (email's total cap is higher).
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

_CHANNEL_LABEL = {"email": "email", "whatsapp": "WhatsApp"}
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def is_send_key(key: str) -> bool:
    return str(key or "").startswith(KEY_PREFIX)


def _safe_name(name: str) -> str:
    cleaned = _SAFE_NAME.sub("_", name).strip("._") or "attachment"
    return cleaned[-120:]


def _workspace(task: kanban_db.Task) -> Path:
    if task.workspace_path:
        return Path(task.workspace_path).expanduser()
    return kanban_db.workspaces_root() / task.id


def _snapshot_path(task_id: str, key: str, name: str) -> Path:
    return kanban_db.outbound_root() / task_id / key[len(KEY_PREFIX):] / name


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 16), b""):
            digest.update(block)
    return digest.hexdigest()


def _snapshot(task: kanban_db.Task, key: str, attach: str) -> dict[str, Any]:
    """Copy ``attach`` (a regular file inside the card's workspace) to the
    outbound store; refuse anything outside it, a credential file, or a file
    over :data:`MAX_ATTACHMENT_BYTES`."""
    from hermes_cli.projects_outputs_api import _DENY_NAMES

    ws = _workspace(task)
    raw = Path(attach).expanduser()
    if not raw.is_absolute():
        raw = ws / raw
    try:
        base = ws.resolve(strict=True)
        real = raw.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError(f"attachment {attach!r} does not exist in the card's workspace")
    if not real.is_relative_to(base):
        raise ValueError("the attachment must be a file inside the card's workspace")
    if not real.is_file():
        raise ValueError(f"attachment {attach!r} is not a regular file")
    if real.name in _DENY_NAMES or real.name.startswith("."):
        raise ValueError(f"{real.name!r} cannot be attached")
    size = real.stat().st_size
    if size > MAX_ATTACHMENT_BYTES:
        raise ValueError(
            f"attachment is {size} bytes; the limit is {MAX_ATTACHMENT_BYTES} bytes"
        )
    name = _safe_name(real.name)
    target = _snapshot_path(task.id, key, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(real, target)
    return {"name": name, "size": size, "sha256": _sha256(target)}


def parse_detail(detail: Optional[str]) -> Optional[dict[str, Any]]:
    """The proposed message stored on a ``send:`` approval, or None."""
    try:
        data = json.loads(detail or "")
    except (TypeError, ValueError):
        return None
    if isinstance(data, dict) and data.get("kind") == DETAIL_KIND:
        return data
    return None


def propose(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    channel: str,
    target: str,
    account: str,
    body: str,
    subject: str = "",
    attach: Optional[str] = None,
    run_id: Optional[int] = None,
) -> dict[str, Any]:
    """Record a proposed outgoing message on a project card as a pending card
    approval. Never sends. Raises ``ValueError`` on an invalid proposal."""
    task = kanban_db.get_task(conn, task_id)
    if task is None:
        raise ValueError(f"unknown card {task_id}")
    if not task.project_id:
        raise ValueError(f"card {task_id} is not on a project")
    channel = (channel or "").strip().lower()
    if channel not in CHANNELS:
        raise ValueError(f"channel must be one of: {', '.join(CHANNELS)}")
    account = (account or "").strip()
    if not account:
        raise ValueError(
            "account is required: name the account the message leaves from "
            "(an email account id/address or a WhatsApp bridge name)"
        )
    if channel == "email" and not (subject or "").strip():
        raise ValueError("an email needs a subject")
    if "MEDIA:" in (body or ""):
        raise ValueError("attach files with --attach, not MEDIA: lines in the body")
    if run_id is None:
        run_id = task.current_run_id
    if len((body or "").strip()) > todo_outbound.MAX_BODY_CHARS:
        raise ValueError(
            f"the body is over {todo_outbound.MAX_BODY_CHARS} characters"
        )
    if len((subject or "").strip()) > todo_outbound.MAX_SUBJECT_CHARS:
        raise ValueError(
            f"the subject is over {todo_outbound.MAX_SUBJECT_CHARS} characters"
        )
    try:
        action = todo_outbound.parse_action(
            {
                "channel": channel,
                "target": target,
                "account_id": account,
                "subject": subject,
                "body": body,
            }
        )
    except todo_outbound.OutboundError as exc:
        raise ValueError(str(exc)) from exc

    key = f"{KEY_PREFIX}{uuid.uuid4().hex[:12]}"
    attachment = _snapshot(task, key, attach) if attach else None
    detail = {
        "kind": DETAIL_KIND,
        "channel": action.channel,
        "target": action.target,
        "account": action.account_id,
        "subject": action.subject,
        "body": action.body,
        "attachment": attachment,
    }
    label = (
        f"Send {_CHANNEL_LABEL[channel]} to {action.target} from {action.account_id}"
    )[:200]
    kanban_db.request_task_approval(
        conn,
        task_id,
        [(key, label)],
        detail=json.dumps(detail, ensure_ascii=False),
        run_id=run_id,
    )
    kanban_db.append_event(
        conn,
        task_id,
        "outbound_proposed",
        {
            "key": key,
            "channel": action.channel,
            "target": action.target,
            "account": action.account_id,
            "attachment": attachment["name"] if attachment else None,
            "run_id": run_id,
        },
    )
    return {"key": key, "label": label, "status": "pending", **detail}


def _already_sent(conn: sqlite3.Connection, task_id: str, key: str) -> bool:
    return any(
        ev.kind == "outbound_sent" and (ev.payload or {}).get("key") == key
        for ev in kanban_db.list_events(conn, task_id)
    )


def deliver(
    conn: sqlite3.Connection, task_id: str, key: str, *, actor: str
) -> dict[str, Any]:
    """Send an approved ``send:`` proposal exactly once.

    Returns ``{"event": "sent"|"failed", ...}`` after an attempt, or
    ``{"error": <code>, "detail": ...}`` on a refusal (nothing attempted).
    A failed attempt puts the approval back to pending.
    """
    row = conn.execute(
        "SELECT status, detail FROM task_approvals "
        "WHERE task_id = ? AND approval_key = ?",
        (task_id, key),
    ).fetchone()
    if row is None:
        return {"error": "no_approval", "detail": "No such proposal on this card."}
    if row["status"] != "approved":
        return {"error": row["status"], "detail": f"The proposal is {row['status']}."}
    if _already_sent(conn, task_id, key):
        return {"error": "already_sent", "detail": "This proposal was already sent."}
    msg = parse_detail(row["detail"])
    if msg is None:
        return {"error": "unparseable", "detail": "The proposal could not be read."}

    attachments: list[str] = []
    att = msg.get("attachment")
    error: Optional[str] = None
    if att:
        path = _snapshot_path(task_id, key, _safe_name(str(att.get("name") or "")))
        if not path.is_file():
            error = f"the attachment {att.get('name')!r} is no longer available"
        elif _sha256(path) != att.get("sha256"):
            error = f"the attachment {att.get('name')!r} changed after it was proposed"
        else:
            attachments.append(str(path))

    if error is None:
        result = todo_outbound.deliver_message(
            channel=str(msg.get("channel") or ""),
            target=str(msg.get("target") or ""),
            body=str(msg.get("body") or ""),
            account=msg.get("account") or None,
            subject=msg.get("subject") or None,
            attachments=attachments,
        )
        error = result.get("error") if isinstance(result, dict) else "no result"
    else:
        result = {"error": error}

    payload = {
        "key": key,
        "channel": msg.get("channel"),
        "target": msg.get("target"),
        "account": msg.get("account"),
        "attachment": att.get("name") if att else None,
        "by": actor,
    }
    if error:
        payload["error"] = str(error)[:500]
        kanban_db.append_event(conn, task_id, "outbound_failed", payload)
        kanban_db.reopen_task_approval(conn, task_id, key)
        return {"event": "failed", "error": str(error), "result": result}
    kanban_db.append_event(conn, task_id, "outbound_sent", payload)
    return {"event": "sent", "result": result}
