"""FG-03 P6 — which account an approved reply leaves through, and who may send it.

"Replies leave via the receiving account and always need approval." The box
source registry (:mod:`hermes_cli.source_registry`) names one owner per
incoming account, so a reply's ``account`` is resolved there first: the
source by ``(channel, address)`` (``tgbot:<id>`` → the Telegram bot source),
then its ``credential_ref`` → the owner's saved credential (the
``telegram-bot`` token, the personal mailbox's SMTP settings) or the
install-wide pipeline config the source was registered from. An account the
registry does not know falls back to the config paths
:mod:`tools.send_message_tool` always used.

Two refusals guard every send (:func:`check_reply`): the acting principal must
own the source, and the account (and, for Telegram, the chat) must be the one
the arrival came in on. Secrets resolved here only ever live in the returned
in-memory :class:`~gateway.config.PlatformConfig`.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Mapping, Optional

from hermes_cli import source_registry as registry
from hermes_cli.telegram_triage import ACCOUNT_PREFIX as TELEGRAM_ACCOUNT_PREFIX

log = logging.getLogger(__name__)

#: Credential kinds a registry source's ``credential_ref`` may point at.
TELEGRAM_BOT_KIND = ("telegram-bot", "telegram")
MAILBOX_KIND = ("email-imap", "imap")
EMAIL_POLLER_KIND = "email-poller-config"
WA_BRIDGE_KIND = "wa-bridge"
WA_POLLER_KIND = "wa-poller-config"


class ReplyRefused(Exception):
    """A reply that must not leave: wrong sender, or not the arrival's account."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def registry_key(channel: str, account: str) -> Optional[tuple[str, str]]:
    """``(channel, address)`` of the registry source ``account`` names, if any.

    Telegram only maps person bots (``tgbot:<id>``); the install's own bot is
    not a registry source. Pipeline account ids (an email ``accounts[].id`` or
    a WhatsApp ``phones[].id``) map through the pipeline config to the
    address the source was registered under.
    """
    channel = (channel or "").strip().lower()
    account = (account or "").strip()
    if channel not in registry.CHANNELS or not account:
        return None
    if channel == "telegram" and not account.startswith(TELEGRAM_ACCOUNT_PREFIX):
        return None
    try:
        return channel, registry.normalize_address(channel, account)
    except registry.SourceRegistryError:
        pass
    address = _pipeline_address(channel, account)
    if address:
        try:
            return channel, registry.normalize_address(channel, address)
        except registry.SourceRegistryError:
            return None
    return None


def _pipeline_address(channel: str, account: str) -> Optional[str]:
    import json
    import os
    from pathlib import Path

    if channel == "email":
        path = os.environ.get("EMAIL_CONFIG_PATH", "/opt/data/email-messages/config.json")
    else:
        path = os.environ.get(
            "WHATSAPP_CONFIG_PATH", "/opt/data/whatsapp-messages/config.json"
        )
    key, field = ("accounts", "address") if channel == "email" else ("phones", "number")
    try:
        entries = (json.loads(Path(path).read_text(encoding="utf-8")) or {}).get(key) or []
    except (OSError, ValueError):
        return None
    for entry in entries:
        if isinstance(entry, dict) and str(entry.get("id") or "") == account:
            return str(entry.get(field) or "") or None
    return None


async def find_source(
    channel: str,
    account: str,
    *,
    connection: Any = None,
) -> Optional[registry.Source]:
    """The registry source behind a reply account, or ``None`` (not registered,
    or no registry on this box — the caller falls back to the config paths)."""
    key = registry_key(channel, account)
    if key is None:
        return None
    if connection is not None:
        return await registry.get_source_by_address(connection, *key)
    try:
        with registry.default_profile_scope():
            conn = await registry.connect_box()
    except Exception as exc:  # noqa: BLE001 - no registry: legacy config paths
        log.debug("reply_accounts: source registry unavailable (%s)", exc)
        return None
    try:
        return await registry.get_source_by_address(conn, *key)
    finally:
        await conn.close()


async def check_reply(
    user_id: str,
    channel: str,
    account: Optional[str],
    *,
    target: Optional[str] = None,
    arrival: Optional[Mapping[str, Any]] = None,
    connection: Any = None,
) -> Optional[registry.Source]:
    """Refuse a reply the acting ``user_id`` may not send; return its source.

    * the reply must leave on the arrival's channel and account (and reach a
      Telegram arrival's own chat) — never a different account;
    * a registered source may only be replied from by its owner.
    """
    channel = (channel or "").strip().lower()
    account = (account or "").strip() or None
    if arrival:
        surface = str(arrival.get("surface") or "").strip().lower()
        received_on = str(arrival.get("account_id") or "").strip() or None
        if surface and surface != channel:
            raise ReplyRefused(
                "wrong_account",
                f"The arrival came in on {surface}; refusing to reply on {channel}.",
            )
        if received_on and not _same_account(channel, account, received_on):
            raise ReplyRefused(
                "wrong_account",
                f"The arrival came in on account {received_on!r}; refusing to "
                f"reply from {account!r}.",
            )
        if channel == "telegram" and target is not None:
            chat = str(arrival.get("conversation") or arrival.get("sender_id") or "")
            if chat and str(target).strip() != chat:
                raise ReplyRefused(
                    "wrong_chat",
                    f"The arrival came in on Telegram chat {chat}; refusing to "
                    f"reply to {target}.",
                )
    if not account:
        return None
    source = await find_source(channel, account, connection=connection)
    if source is not None and source.owner_user_id != (user_id or ""):
        raise ReplyRefused(
            "not_source_owner",
            f"{account!r} belongs to another user; only its owner can reply from it.",
        )
    return source


def _same_account(channel: str, account: Optional[str], received_on: str) -> bool:
    if not account:
        return False
    if account == received_on:
        return True
    a, b = registry_key(channel, account), registry_key(channel, received_on)
    return a is not None and a == b


# -- credentials ---------------------------------------------------------------

async def _owner_credential(
    source: registry.Source, kind: str, provider: str, match
) -> Any:
    """The source owner's saved ``kind`` credential ``match`` accepts, read in
    the profile the ``credential_ref`` names (its owner's own, never another's)."""
    from hermes_cli.console_scope import _scoped_to
    from hermes_cli.credential_store import default_credential_store

    ref = source.credential_ref or {}
    profile = str(ref.get("profile") or registry.DEFAULT_PROFILE)
    entry = registry._registry_entry(profile)
    if entry is None:
        return None
    with _scoped_to(entry.hermes_home):
        creds = await default_credential_store().resolve_by_kind(kind, provider=provider)
    for cred in creds:
        if cred.owner_user_id == source.owner_user_id and match(cred):
            return cred
    return None


async def source_pconfig(source: registry.Source, *, subject: Optional[str] = None):
    """A send-only :class:`PlatformConfig` for ``source``, or ``None``."""
    from gateway.config import PlatformConfig
    from tools import send_message_tool as smt

    ref = source.credential_ref or {}
    kind = str(ref.get("kind") or "")
    if source.channel == "telegram":
        cred = await _owner_credential(
            source, *TELEGRAM_BOT_KIND,
            match=lambda c: str((c.payload or {}).get("token") or "").split(":", 1)[0]
            == source.address,
        )
        token = str(((cred.payload if cred else None) or {}).get("token") or "")
        if not token:
            return None
        return PlatformConfig(
            enabled=True,
            token=token,
            extra={"account_id": f"{TELEGRAM_ACCOUNT_PREFIX}{source.address}"},
        )
    if source.channel == "email":
        if kind in ("", MAILBOX_KIND[0]):
            cred = await _owner_credential(
                source, *MAILBOX_KIND,
                match=lambda c: str(c.name or "").strip().lower() == source.address,
            )
            if cred is not None:
                payload = cred.payload or {}
                extra = {
                    "address": source.address,
                    "username": payload.get("username") or source.address,
                    "password": payload.get("password") or "",
                    "smtp_host": payload.get("smtp_host") or "",
                    "smtp_port": payload.get("smtp_port") or 587,
                    "smtp_security": payload.get("smtp_security") or "ssl",
                }
                if subject:
                    extra["subject"] = subject
                return PlatformConfig(enabled=True, extra=extra)
        return smt._email_account_pconfig(
            str(ref.get("name") or source.address), subject=subject
        ) or smt._email_account_pconfig(source.address, subject=subject)
    if source.channel == "whatsapp":
        port = None
        if ref.get("port"):
            try:
                port = int(ref["port"])
            except (TypeError, ValueError):
                port = None
        if port is None and ref.get("bridge"):
            port = smt._whatsapp_bridge_map().get(str(ref["bridge"]))
        if port is None:
            port = smt._resolve_whatsapp_bridge_port(str(ref.get("name") or "")) or (
                smt._resolve_whatsapp_bridge_port(source.address)
            )
        if port is None:
            return None
        return PlatformConfig(enabled=True, extra={"bridge_port": port})
    return None


def _run(coro_fn):
    """Run ``coro_fn()`` to completion from sync code, loop or no loop, keeping
    the caller's context (profile scope, acting principal)."""
    context = contextvars.copy_context()
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(context.run, lambda: asyncio.run(coro_fn())).result(timeout=60)


def resolve_send_account(
    platform_name: str,
    account: str,
    *,
    subject: Optional[str] = None,
    user_id: Optional[str] = None,
):
    """Sync seam for :func:`tools.send_message_tool._account_pconfig`.

    Returns ``(source, pconfig)``: ``(None, None)`` when the registry does not
    know the account (fall back to config paths); a registered source whose
    credential cannot be resolved returns ``(source, None)`` and is refused.
    Raises :class:`ReplyRefused` when ``user_id`` is bound and not the owner.
    """

    async def resolve():
        source = await find_source(platform_name, account)
        if source is None:
            return None, None
        if user_id is not None and source.owner_user_id != user_id:
            raise ReplyRefused(
                "not_source_owner",
                f"{account!r} belongs to another user; only its owner can reply from it.",
            )
        return source, await source_pconfig(source, subject=subject)

    return _run(resolve)
