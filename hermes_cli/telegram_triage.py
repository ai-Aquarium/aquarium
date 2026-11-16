"""FG-03 P6 — Telegram bots as triage sources: the shared contract.

The gateway's person-bot adapter is the only reader of a bot (Telegram allows
one ``getUpdates`` poller per token). Messages from the bot's linked owner stay
the owner's own chat, as today. When ``triage.agent.telegram`` is ``agent`` and
the bot is an enabled source in the box registry with at least one enabled
route, messages from anyone else are never given to an agent turn: the gateway
writes them to a batch file here, and ``custom/telegram/triage_agent.py`` routes
each batch once (P4) and triages it in each chosen user-profile's agent (P5).

There is no legacy triage for Telegram, so the switch is ``off | agent``.

Batch file (one chat per batch, written atomically, complete when it appears)::

    {
      "batch_id": "tg_<bot id>_<chat id>_<first message id>",
      "channel": "telegram",
      "source_id": "<registry source uuid>",
      "owner_user_id": "<source owner>",
      "account_id": "tgbot:<bot id>",
      "chat_id": "<chat id>",
      "chat_type": "dm" | "group",
      "chat_title": "<group title or sender name>",
      "created_at": "<ISO-8601 UTC>",
      "messages": [
        {"message_id": "<id>", "sender_id": "<telegram user id>",
         "sender_name": "<display name>", "sender_username": "<@handle or ''>",
         "text": "<text or caption>", "timestamp": "<ISO-8601 UTC>",
         "media": [<optional media descriptors>]}
      ]
    }

``chat_type`` is ``dm`` for a private chat and ``group`` for a group or
supergroup. Each ``media`` descriptor is ``{"type": "photo" | "video" |
"audio" | "voice" | "document" | "sticker", "file_id", "file_unique_id",
optional "mime_type" / "file_name" / "file_size"}`` (download it through the
receiving bot) or ``{"type": "location", "latitude", "longitude"}`` (plus
``"title"`` / ``"address"`` for a shared venue); nothing is downloaded at
capture time. Edits of an already captured message are not
captured again.

Replies always go back through the receiving bot (``account_id``) to
``chat_id`` and need the owner's approval; auto-send stays off.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping, Optional

MODES: tuple[str, ...] = ("off", "agent")
DEFAULT_MODE = "off"
ACCOUNT_PREFIX = "tgbot:"

BASE_DIR = Path("/opt/data/telegram-messages")
BATCH_DIR = BASE_DIR / "batches"
PROCESSED_DIR = BASE_DIR / "processed"

#: Gateway capture (``gateway/person_telegram_bots.py``): a chat's batch is
#: written after this many quiet seconds, so a burst becomes one batch ...
CAPTURE_QUIET_SECONDS = 20.0
#: ... but never later than this after its first message, or past this size.
CAPTURE_MAX_SECONDS = 120.0
CAPTURE_MAX_MESSAGES = 50


def mode(config: Optional[Mapping[str, Any]] = None) -> str:
    """``triage.agent.telegram``: ``off`` (default) or ``agent``."""
    if config is None:
        from hermes_cli.config import load_config

        config = load_config()
    triage = (config or {}).get("triage") or {}
    agent = triage.get("agent") if isinstance(triage, Mapping) else None
    value = agent.get("telegram") if isinstance(agent, Mapping) else None
    value = str(value or "").strip().lower()
    return value if value in MODES else DEFAULT_MODE


def batch_id_for(bot_id: str, chat_id: str, first_message_id: str) -> str:
    return f"tg_{bot_id}_{chat_id}_{first_message_id}".replace("-", "m")


def write_batch(batch: Mapping[str, Any], *, batch_dir: Optional[Path] = None) -> Path:
    """Write ``batch`` atomically to ``<batch_dir>/<batch_id>.json``."""
    target_dir = Path(batch_dir) if batch_dir is not None else BATCH_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{batch['batch_id']}.json"
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dict(batch), f)
    os.replace(tmp, path)
    return path
