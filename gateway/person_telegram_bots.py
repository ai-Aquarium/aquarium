"""Per-person Telegram bots (Get ready item 6).

Each person may save their own @BotFather bot under ``/api/telegram-bot``
(``hermes_cli/telegram_bot_api.py``; credential kind ``telegram-bot``). Once
the person has linked their Telegram account, the gateway runs that bot next
to the install-wide bot (``TELEGRAM_BOT_TOKEN``, untouched) and:

* accepts only private chats from the linked Telegram id (adapter
  ``allow_from`` at intake, re-checked in :meth:`_person_bot_authorization`);
* handles every message as the bot's owner (``internal_user_id`` is stamped
  from the credential owner, never resolved from the sender);
* replies through the same bot (``account_id = "tgbot:<bot id>"``).

FG-03 P6 capture: when ``triage.agent.telegram`` is ``agent`` and the bot is an
enabled ``telegram`` source in the box registry with at least one enabled
route, messages from anyone else (DMs, and groups the bot is in) that the
adapter's ``allow_from`` refused are written as triage batch files
(:mod:`hermes_cli.telegram_triage`): one chat per batch, a burst becomes one
batch. They never reach :meth:`_handle_message` and get no reply. The registry
answer is cached for a minute; when the registry can't be read, others are
ignored, as without capture. A batch whose write fails is kept and retried
with a capped backoff; stopping a bot first stops its intake, then waits for
captures under way and writes every batch it still holds.

Adding, changing or removing one person's bot starts/stops only that bot.
The API touches ``$HERMES_HOME/telegram_bots.changed`` after every change;
the loop below notices within a few seconds and also re-reads periodically.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from gateway.config import Platform, PlatformConfig

logger = logging.getLogger(__name__)

ACCOUNT_PREFIX = "tgbot:"
_POLL_SECONDS = 5.0
_FULL_RESYNC_SECONDS = 300.0
#: How long a registry answer for the capture decision is reused.
_CAPTURE_TTL = 60.0
_CAPTURE_FAIL_TTL = 15.0
_REGISTRY_TIMEOUT = 10.0
#: Backoff between writes of a batch whose write failed (2 s, 4 s, ... at most 5 min).
_RETRY_FIRST_SECONDS = 2.0
_RETRY_MAX_SECONDS = 300.0


@dataclass(frozen=True)
class CaptureTarget:
    """Where a person bot's captured messages go: its registry source."""

    source_id: str
    owner_user_id: str


@dataclass
class _PendingBatch:
    account_id: str
    target: CaptureTarget
    chat_id: str
    chat_type: str
    chat_title: str
    started: float
    messages: List[Dict[str, Any]] = field(default_factory=list)
    task: Optional[asyncio.Task] = None


@dataclass
class _FailedBatch:
    account_id: str
    record: Dict[str, Any]
    attempts: int
    task: Optional[asyncio.Task] = None


_MESSAGE_KEYS = ("message_id", "sender_id", "sender_name", "sender_username", "text", "timestamp", "media")


@dataclass(frozen=True)
class PersonBotSpec:
    account_id: str
    owner_user_id: str
    linked_user_id: str
    token: str

    @property
    def fingerprint(self) -> str:
        raw = f"{self.owner_user_id}|{self.linked_user_id}|{self.token}"
        return hashlib.sha256(raw.encode()).hexdigest()


def desired_person_bots(entries: List[Any], *, install_token: str = "") -> Dict[str, PersonBotSpec]:
    """Linked ``telegram-bot`` entries keyed by account id.

    A bot claimed by two owners, or the install bot itself, is never run.
    """
    install_bot_id = install_token.split(":", 1)[0] if install_token else ""
    specs: Dict[str, PersonBotSpec] = {}
    clashes = set()
    for cred in entries:
        payload = getattr(cred, "payload", None) or {}
        token = str(payload.get("token") or "").strip()
        linked = str(payload.get("linked_user_id") or "").strip()
        if not token or not linked or getattr(cred, "kind", "") != "telegram-bot":
            continue
        bot_id = token.split(":", 1)[0]
        if bot_id == install_bot_id:
            continue
        account_id = f"{ACCOUNT_PREFIX}{bot_id}"
        if account_id in specs:
            clashes.add(account_id)
            continue
        specs[account_id] = PersonBotSpec(account_id, str(cred.owner_user_id), linked, token)
    for account_id in clashes:
        logger.error("Telegram bot %s is saved by more than one person; not running it", account_id)
        specs.pop(account_id, None)
    return specs


class PersonTelegramBotsMixin:
    """Lifecycle + routing for per-person Telegram bots on ``GatewayRunner``."""

    def _person_bots(self) -> Dict[str, Any]:
        bots = getattr(self, "_person_bot_adapters", None)
        if bots is None:
            bots = self._person_bot_adapters = {}
        return bots

    def _person_bot_spec_map(self) -> Dict[str, PersonBotSpec]:
        specs = getattr(self, "_person_bot_specs", None)
        if specs is None:
            specs = self._person_bot_specs = {}
        return specs

    def _source_adapter(self, source: Any):
        """The adapter a reply to ``source`` must leave through."""
        account_id = getattr(source, "account_id", None)
        if account_id and str(account_id).startswith(ACCOUNT_PREFIX):
            return self._person_bots().get(str(account_id))
        if account_id and str(account_id).startswith("wabridge:"):
            return self._person_wa_adapters().get(str(account_id))
        return self.adapters.get(source.platform)

    def _person_bot_authorization(self, source: Any) -> Optional[bool]:
        """``None`` for any other source; else whether the sender may use the bot."""
        account_id = str(getattr(source, "account_id", None) or "")
        if not account_id.startswith(ACCOUNT_PREFIX):
            return None
        spec = self._person_bot_spec_map().get(account_id)
        return bool(
            spec is not None
            and getattr(source, "platform", None) == Platform.TELEGRAM
            and getattr(source, "chat_type", None) == "dm"
            and str(getattr(source, "user_id", None) or "") == spec.linked_user_id
        )

    async def _load_person_bot_entries(self) -> List[Any]:
        from hermes_cli.credential_store import default_credential_store

        return await default_credential_store().resolve_by_kind("telegram-bot", provider="telegram")

    async def _reconcile_person_telegram_bots(self) -> None:
        try:
            entries = await self._load_person_bot_entries()
        except Exception:
            logger.warning("Could not read per-person Telegram bots", exc_info=True)
            return
        desired = desired_person_bots(entries, install_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip())
        specs = self._person_bot_spec_map()
        bots = self._person_bots()
        for account_id in list(specs):
            want = desired.get(account_id)
            if want is None or want.fingerprint != specs[account_id].fingerprint:
                await self._stop_person_bot(account_id)
        for account_id, spec in desired.items():
            if account_id not in bots:
                await self._start_person_bot(spec)

    async def _start_person_bot(self, spec: PersonBotSpec) -> bool:
        config = PlatformConfig(
            enabled=True,
            token=spec.token,
            extra={
                "account_id": spec.account_id,
                "allow_from": [spec.linked_user_id],
                "force_polling": True,
            },
        )
        adapter = self._create_adapter(Platform.TELEGRAM, config)
        if adapter is None:
            return False
        adapter.set_message_handler(self._make_person_bot_message_handler(spec.account_id))
        adapter.set_fatal_error_handler(self._handle_person_bot_fatal_error)
        adapter.set_session_store(self.session_store)
        adapter.set_busy_session_handler(self._handle_active_session_busy_message)
        adapter.set_authorization_check(self._make_person_bot_auth_check(spec.account_id))
        set_sink = getattr(adapter, "set_refused_message_sink", None)
        if callable(set_sink):
            set_sink(self._make_person_bot_capture(spec.account_id))
        adapter._busy_text_mode = getattr(self, "_busy_text_mode", None)
        # Registered before connect so an early message already routes here.
        self._person_bot_spec_map()[spec.account_id] = spec
        self._person_bots()[spec.account_id] = adapter
        try:
            ok = await self._connect_adapter_with_timeout(adapter, Platform.TELEGRAM)
        except Exception:
            logger.warning("Telegram bot %s failed to start", spec.account_id, exc_info=True)
            ok = False
        if not ok:
            await self._stop_person_bot(spec.account_id)
            return False
        logger.info("✓ telegram connected (person bot %s)", spec.account_id)
        return True

    async def _stop_person_bot(self, account_id: str) -> None:
        # Stop intake first, then wait for captures already under way and
        # write everything still held for this bot (open and failed batches).
        closing = self._person_bot_capture_state()["closing"]
        spec = self._person_bot_spec_map().pop(account_id, None)
        if spec is not None:
            closing[account_id] = spec
        try:
            adapter = self._person_bots().pop(account_id, None)
            if adapter is not None:
                await self._safe_adapter_disconnect(adapter, Platform.TELEGRAM)
            await self._drain_person_bot_captures(account_id)
        finally:
            closing.pop(account_id, None)

    async def _handle_person_bot_fatal_error(self, adapter: Any) -> None:
        for account_id, live in list(self._person_bots().items()):
            if live is adapter:
                logger.warning("Telegram bot %s stopped after an error; will retry", account_id)
                await self._stop_person_bot(account_id)

    def _make_person_bot_auth_check(self, account_id: str):
        def check(user_id: str, chat_type: Optional[str] = None, chat_id: Optional[str] = None) -> bool:
            spec = self._person_bot_spec_map().get(account_id)
            return bool(spec and str(user_id or "") == spec.linked_user_id and chat_type in (None, "dm"))

        return check

    def _make_person_bot_message_handler(self, account_id: str):
        async def _handler(event):
            source = getattr(event, "source", None)
            spec = self._person_bot_spec_map().get(account_id)
            if source is None or spec is None:
                return None
            source.account_id = account_id
            if not self._person_bot_authorization(source):
                logger.info("Ignored a message to Telegram bot %s from an unlinked sender", account_id)
                return None
            principal = await self._person_bot_owner(spec.owner_user_id)
            if principal is None:
                logger.warning("Telegram bot %s: owner is not an active person; ignored", account_id)
                return None
            source.internal_user_id = principal.user_id
            source.internal_user_role = principal.role
            return await self._handle_message(event)

        return _handler

    # -- FG-03 P6: capture of other senders' messages as triage batches --------

    def _person_bot_capture_state(self) -> Dict[str, Any]:
        state = getattr(self, "_person_bot_capture", None)
        if state is None:
            state = self._person_bot_capture = {
                "sources": None, "expires": 0.0, "lock": asyncio.Lock(), "pending": {},
                "retry": {}, "busy": {}, "closing": {},
            }
        return state

    def _person_bot_capture_spec(self, account_id: str):
        """The bot's spec while it runs or while its stop drains its captures."""
        spec = self._person_bot_spec_map().get(account_id)
        return spec if spec is not None else self._person_bot_capture_state()["closing"].get(account_id)

    def _person_bot_capture_task(self, account_id: str, coro) -> asyncio.Task:
        """Run ``coro`` as capture work a stop of ``account_id`` waits for."""
        busy = self._person_bot_capture_state()["busy"].setdefault(account_id, set())
        task = asyncio.ensure_future(coro)
        busy.add(task)
        task.add_done_callback(busy.discard)
        return task

    async def _load_telegram_capture_sources(self) -> Optional[Dict[str, CaptureTarget]]:
        """Bot id -> target for routed telegram sources, or ``None`` (capture off)."""
        from hermes_cli import telegram_triage

        if await asyncio.to_thread(telegram_triage.mode) != "agent":
            return None
        from hermes_cli.source_registry import connect_box, list_sources

        connection = await asyncio.wait_for(connect_box(), _REGISTRY_TIMEOUT)
        try:
            sources = await asyncio.wait_for(list_sources(connection, channel="telegram"), _REGISTRY_TIMEOUT)
        finally:
            await connection.close()
        return {
            s.address: CaptureTarget(s.source_id, s.owner_user_id)
            for s in sources
            if s.routed_profiles()
        }

    async def _telegram_capture_sources(self) -> Optional[Dict[str, CaptureTarget]]:
        state = self._person_bot_capture_state()
        async with state["lock"]:
            now = time.monotonic()
            if now < state["expires"]:
                return state["sources"]
            try:
                sources = await self._load_telegram_capture_sources()
                ttl = _CAPTURE_TTL
            except Exception:
                logger.warning("Could not read the Telegram triage sources; others' messages are ignored", exc_info=True)
                sources, ttl = None, _CAPTURE_FAIL_TTL
            state["sources"], state["expires"] = sources, time.monotonic() + ttl
            return sources

    async def _person_bot_capture_target(self, account_id: str) -> Optional[CaptureTarget]:
        """The registry source capturing ``account_id``'s other senders, or ``None``."""
        spec = self._person_bot_capture_spec(account_id)
        if spec is None:
            return None
        sources = await self._telegram_capture_sources()
        target = (sources or {}).get(account_id[len(ACCOUNT_PREFIX):])
        if target is None:
            return None
        if target.owner_user_id != spec.owner_user_id:
            logger.warning(
                "Telegram bot %s is a registry source of another person than the bot's owner; not captured",
                account_id,
            )
            return None
        return target

    def _make_person_bot_capture(self, account_id: str):
        async def _capture(record: Dict[str, Any]) -> None:
            await asyncio.shield(
                self._person_bot_capture_task(account_id, self._capture_person_bot_record(account_id, record))
            )

        return _capture

    async def _capture_person_bot_record(self, account_id: str, record: Dict[str, Any]) -> None:
        spec = self._person_bot_capture_spec(account_id)
        if spec is None or str(record.get("sender_id") or "") == spec.linked_user_id:
            return
        target = await self._person_bot_capture_target(account_id)
        if target is None:
            logger.info("Ignored a message to Telegram bot %s from an unlinked sender", account_id)
            return
        await self._add_person_bot_capture(account_id, target, record)

    async def _add_person_bot_capture(
        self, account_id: str, target: CaptureTarget, record: Dict[str, Any]
    ) -> None:
        from hermes_cli import telegram_triage

        pending: Dict[Tuple[str, str], _PendingBatch] = self._person_bot_capture_state()["pending"]
        key = (account_id, str(record["chat_id"]))
        batch = pending.get(key)
        if batch is not None and batch.target != target:
            await self._flush_person_bot_capture(key)
            batch = None
        if batch is None:
            batch = pending[key] = _PendingBatch(
                account_id, target, key[1], record["chat_type"], record.get("chat_title") or "",
                time.monotonic(),
            )
        message = {k: record.get(k, [] if k == "media" else "") for k in _MESSAGE_KEYS}
        if any(m["message_id"] == message["message_id"] for m in batch.messages):
            return
        batch.messages.append(message)
        if batch.task is not None and not batch.task.done():
            batch.task.cancel()
        if len(batch.messages) >= telegram_triage.CAPTURE_MAX_MESSAGES:
            await self._flush_person_bot_capture(key)
            return
        left = telegram_triage.CAPTURE_MAX_SECONDS - (time.monotonic() - batch.started)
        delay = max(0.0, min(telegram_triage.CAPTURE_QUIET_SECONDS, left))
        batch.task = asyncio.create_task(self._flush_person_bot_capture_later(key, batch, delay))

    async def _flush_person_bot_capture_later(self, key, batch: _PendingBatch, delay: float) -> None:
        await asyncio.sleep(delay)
        if self._person_bot_capture_state()["pending"].get(key) is batch:
            batch.task = None
            await self._flush_person_bot_capture(key)

    async def _flush_person_bot_capture(self, key) -> Optional[Any]:
        from hermes_cli import telegram_triage

        batch = self._person_bot_capture_state()["pending"].pop(key, None)
        if batch is None or not batch.messages:
            return None
        if batch.task is not None and batch.task is not asyncio.current_task() and not batch.task.done():
            batch.task.cancel()
        bot_id = batch.account_id[len(ACCOUNT_PREFIX):]
        record = {
            "batch_id": telegram_triage.batch_id_for(bot_id, batch.chat_id, batch.messages[0]["message_id"]),
            "channel": "telegram",
            "source_id": batch.target.source_id,
            "owner_user_id": batch.target.owner_user_id,
            "account_id": batch.account_id,
            "chat_id": batch.chat_id,
            "chat_type": batch.chat_type,
            "chat_title": batch.chat_title,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "messages": batch.messages,
        }
        return await asyncio.shield(
            self._person_bot_capture_task(batch.account_id, self._write_person_bot_batch(batch.account_id, record))
        )

    async def _write_person_bot_batch(
        self, account_id: str, record: Dict[str, Any], *, attempts: int = 0, final: bool = False
    ) -> Optional[Any]:
        """Write one batch; a failed write is queued for a retry unless ``final``."""
        from hermes_cli import telegram_triage

        try:
            path = await asyncio.to_thread(
                telegram_triage.write_batch, record, batch_dir=telegram_triage.BATCH_DIR
            )
        except Exception:
            attempts += 1
            if final:
                logger.error(
                    "Could not write Telegram triage batch %s after %d attempt(s); %d message(s) lost",
                    record["batch_id"], attempts, len(record["messages"]), exc_info=True,
                )
                return None
            logger.warning(
                "Could not write Telegram triage batch %s (attempt %d); will retry",
                record["batch_id"], attempts, exc_info=True,
            )
            self._queue_person_bot_batch_retry(_FailedBatch(account_id, record, attempts))
            return None
        logger.info(
            "Telegram bot %s: %d message(s) from chat %s -> triage batch %s",
            account_id, len(record["messages"]), record["chat_id"], record["batch_id"],
        )
        return path

    def _queue_person_bot_batch_retry(self, failed: _FailedBatch) -> None:
        state = self._person_bot_capture_state()
        state["retry"][failed.record["batch_id"]] = failed
        if failed.account_id in state["closing"]:
            return  # the stop's drain makes the last attempt
        delay = min(_RETRY_MAX_SECONDS, _RETRY_FIRST_SECONDS * 2 ** (failed.attempts - 1))
        failed.task = asyncio.create_task(self._retry_person_bot_batch_later(failed, delay))

    async def _retry_person_bot_batch_later(self, failed: _FailedBatch, delay: float) -> None:
        await asyncio.sleep(delay)
        retry = self._person_bot_capture_state()["retry"]
        if retry.get(failed.record["batch_id"]) is not failed:
            return
        del retry[failed.record["batch_id"]]
        failed.task = None
        await asyncio.shield(self._person_bot_capture_task(
            failed.account_id,
            self._write_person_bot_batch(failed.account_id, failed.record, attempts=failed.attempts),
        ))

    async def _drain_person_bot_captures(self, account_id: str) -> None:
        """Wait for ``account_id``'s capture work, then write every batch it still holds."""
        state = self._person_bot_capture_state()
        while True:
            busy = list(state["busy"].get(account_id, ()))
            if busy:
                await asyncio.gather(*busy, return_exceptions=True)
                continue
            keys = [k for k in state["pending"] if k[0] == account_id]
            failed = [f for f in state["retry"].values() if f.account_id == account_id]
            if not keys and not failed:
                return
            for key in keys:
                await self._flush_person_bot_capture(key)
            for f in failed:
                state["retry"].pop(f.record["batch_id"], None)
                if f.task is not None and not f.task.done():
                    f.task.cancel()
                await self._write_person_bot_batch(account_id, f.record, attempts=f.attempts, final=True)

    async def _person_bot_owner(self, owner_user_id: str):
        store = self._get_principal_store()
        if store is None:
            return None
        try:
            principal = await store.get(owner_user_id)
        except Exception:
            logger.warning("Could not resolve the owner of a Telegram bot", exc_info=True)
            return None
        if principal is None or not getattr(principal, "active", True):
            return None
        return principal

    def _person_bot_marker_mtime(self) -> float:
        from hermes_cli.telegram_bot_api import CHANGE_MARKER
        from hermes_constants import get_hermes_home

        try:
            return (get_hermes_home() / CHANGE_MARKER).stat().st_mtime
        except OSError:
            return 0.0

    async def _person_telegram_bots_loop(self) -> None:
        seen = None
        since_full = 0.0
        while getattr(self, "_running", False):
            mtime = self._person_bot_marker_mtime()
            if mtime != seen or since_full >= _FULL_RESYNC_SECONDS:
                seen = mtime
                since_full = 0.0
                try:
                    await self._reconcile_person_telegram_bots()
                except Exception:
                    logger.warning("Per-person Telegram bot sync failed", exc_info=True)
            await asyncio.sleep(_POLL_SECONDS)
            since_full += _POLL_SECONDS

    async def _stop_all_person_bots(self) -> None:
        for account_id in list(self._person_bots()):
            await self._stop_person_bot(account_id)
