"""The batch text the triage router reads (FG-03 P4).

:func:`batch_text` turns an email, WhatsApp or Telegram batch file into a
compact, deterministic summary for
:func:`hermes_cli.triage_router.route_batch_sync`: who sent it, the subjects
and a body snippet for email, the message texts (with each sender in a
Telegram group) for WhatsApp and Telegram. The same batch always gives the same text, capped at
:data:`MAX_BYTES` so one long mail can't make the cheap routing call costly.
"""

from __future__ import annotations

import re
from typing import Any, Mapping

MAX_BYTES = 4096
EMAIL_BODY_CHARS = 600
TRUNCATED = "\n[truncated]"

_SPACE = re.compile(r"\s+")


def _flat(value: Any) -> str:
    return _SPACE.sub(" ", str(value or "")).strip()


def _sender(name: Any, address: Any) -> str:
    name, address = _flat(name), _flat(address)
    if name and address and name != address:
        return f"{name} <{address}>"
    return name or address or "unknown"


def _email_lines(batch: Mapping[str, Any]) -> list[str]:
    emails = batch.get("emails") or []
    lines = [f"Email batch: {len(emails)} email(s) from "
             f"{_sender(batch.get('sender_name'), batch.get('sender'))}"]
    for em in emails:
        lines.append("")
        lines.append(f"From: {_sender(em.get('from_name'), em.get('from_addr'))}")
        subject = _flat(em.get("subject")) or "(no subject)"
        if em.get("has_attachments"):
            subject += " [attachments]"
        lines.append(f"Subject: {subject}")
        body = _flat(em.get("body_text"))
        if len(body) > EMAIL_BODY_CHARS:
            body = body[:EMAIL_BODY_CHARS].rstrip() + " ..."
        if body:
            lines.append(body)
    return lines


def _whatsapp_lines(batch: Mapping[str, Any]) -> list[str]:
    messages = batch.get("messages") or []
    name = next((m.get("sender_name") for m in messages if m.get("sender_name")), "")
    lines = [f"WhatsApp batch: {len(messages)} message(s) from "
             f"{_sender(name, batch.get('sender_phone'))}"]
    if any(m.get("is_group") for m in messages):
        lines.append("(group chat)")
    for m in messages:
        text = _flat(m.get("text"))
        if not text:
            text = f"[{m.get('media_type') or 'media'}]"
        lines.append(f"- {text}")
    return lines


def _telegram_sender(m: Mapping[str, Any]) -> str:
    handle = _flat(m.get("sender_username")).lstrip("@")
    return _sender(m.get("sender_name"), f"@{handle}" if handle else m.get("sender_id"))


def _media(m: Mapping[str, Any]) -> str:
    kinds = [str(d.get("type") or d.get("kind") or "media") if isinstance(d, Mapping) else "media"
             for d in m.get("media") or []]
    return f"[{', '.join(_flat(k) for k in kinds)}]" if kinds else ""


def _telegram_lines(batch: Mapping[str, Any]) -> list[str]:
    """One chat per batch (``hermes_cli.telegram_triage``)."""
    messages = batch.get("messages") or []
    group = batch.get("chat_type") == "group"
    if group:
        lines = [f"Telegram group batch: {len(messages)} message(s) in "
                 f"{_flat(batch.get('chat_title')) or 'a group'}"]
    else:
        first = messages[0] if messages else {}
        lines = [f"Telegram batch: {len(messages)} message(s) from "
                 f"{_telegram_sender(first) if first else _flat(batch.get('chat_title')) or 'unknown'}"]
    for m in messages:
        text = " ".join(p for p in (_flat(m.get("text")), _media(m)) if p) or "[media]"
        lines.append(f"- {_telegram_sender(m)}: {text}" if group else f"- {text}")
    return lines


def batch_text(kind: str, batch: Mapping[str, Any]) -> str:
    """The router's view of ``batch``; ``kind`` is ``email``, ``whatsapp`` or ``telegram``."""
    if kind == "email":
        lines = _email_lines(batch)
    elif kind == "whatsapp":
        lines = _whatsapp_lines(batch)
    elif kind == "telegram":
        lines = _telegram_lines(batch)
    else:
        raise ValueError(f"unknown batch kind {kind!r}")
    text = "\n".join(lines)
    raw = text.encode("utf-8")
    if len(raw) <= MAX_BYTES:
        return text
    keep = MAX_BYTES - len(TRUNCATED.encode("utf-8"))
    return raw[:keep].decode("utf-8", errors="ignore").rstrip() + TRUNCATED
