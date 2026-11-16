"""FG-03 P6 (A) E2E — a person's Telegram bot captures other senders' messages
as triage batches, against the real box registry on real Postgres.

Real profiles over a tmp hermes root (John is in ``cfo``), the real registry in
``aquarium_box``, the real ``config.yaml`` (``triage.agent.telegram``), the real
principal store, and a real :class:`TelegramAdapter` per person bot fed a fake
Telegram update stream. The only stand-ins are the Telegram network (the bot
object records ``send_message``), plugin discovery (the adapter is built
directly) and the agent turn (``_handle_message``).
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import yaml

from gateway.config import GatewayConfig, Platform
from hermes_cli import source_registry as registry
from hermes_cli import telegram_triage
from tests.hermes_cli._pg_fixture import hermes_root, pg_config, postgres_dsn  # noqa: F401
from tests.hermes_cli.test_source_registry_e2e import _box, box  # noqa: F401

JOHN_TOKEN = "333333333:AAjohn" + "j" * 29
BOT_ID = "333333333"
ACCOUNT = f"tgbot:{BOT_ID}"
JOHN_TG, STRANGER, OTHER = "6001", "7001", "7002"
GROUP = "-1004242"


def _config(box, mode):
    cfg = pg_config(box["dsn"])
    cfg["triage"] = {"agent": {"telegram": mode}}
    (box["homes"]["default"] / "config.yaml").write_text(yaml.safe_dump(cfg))


def _register(box, *, routed=True, enabled=True):
    async def setup(c):
        src = await registry.register_source(c, channel="telegram", address=JOHN_TOKEN, owner_user_id="john")
        await registry.set_route(c, source_id=src.source_id, profile_slug="cfo", enabled=routed,
                                 actor_user_id="john")
        await registry.set_source_enabled(c, source_id=src.source_id, enabled=enabled, actor_user_id="john")
        return src

    return _box(box["dsn"], setup)


def _message(message_id, text, *, sender, chat, chat_type, title=None, minute=0):
    return SimpleNamespace(
        message_id=message_id, text=text, caption=None, entities=[], caption_entities=[],
        message_thread_id=None, is_topic_message=False, edit_date=None,
        chat=SimpleNamespace(id=int(chat), type=chat_type, title=title, is_forum=False),
        from_user=SimpleNamespace(id=int(sender), full_name=f"User {sender}", first_name="User",
                                  username=f"u{sender}", is_bot=False),
        reply_to_message=None, date=datetime(2026, 11, 16, 8, minute, tzinfo=timezone.utc),
        location=None, photo=None, video=None, audio=None, voice=None, document=None,
        sticker=None, media_group_id=None, venue=None, forum_topic_created=None,
    )


class Gateway:
    """A GatewayRunner with John's person bot on a real TelegramAdapter."""

    def __init__(self, monkeypatch):
        from gateway.run import GatewayRunner

        runner = object.__new__(GatewayRunner)
        runner.adapters = {}
        runner.config = GatewayConfig()
        runner.session_store = None
        runner._busy_text_mode = None
        runner._running = True
        runner.turns = []
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "")

        async def entries():
            return [SimpleNamespace(kind="telegram-bot", owner_user_id="john",
                                    payload={"token": JOHN_TOKEN, "linked_user_id": JOHN_TG})]

        async def connect(adapter, platform, **_):
            adapter._bot = MagicMock(id=int(BOT_ID), username="johns_bot")
            adapter._bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=900))
            return True

        async def turn(event):
            runner.turns.append(event.source)
            return "on it"

        async def disconnect(adapter, platform):
            pass

        def create(platform, config):
            from plugins.platforms.telegram.adapter import TelegramAdapter

            return TelegramAdapter(config)

        runner._create_adapter = create
        runner._load_person_bot_entries = entries
        runner._connect_adapter_with_timeout = connect
        runner._safe_adapter_disconnect = disconnect
        runner._handle_message = turn
        runner._handle_active_session_busy_message = AsyncMock()
        self.runner = runner

    async def start(self):
        await self.runner._reconcile_person_telegram_bots()
        self.adapter = self.runner._person_bots()[ACCOUNT]
        assert self.adapter.platform == Platform.TELEGRAM
        self.adapter._text_batch_delay_seconds = 0.01
        self.adapter._text_batch_split_delay_seconds = 0.01

    async def feed(self, *messages):
        for i, msg in enumerate(messages):
            await self.adapter._handle_text_message(
                SimpleNamespace(update_id=i, message=msg, effective_message=None), SimpleNamespace())

    @property
    def sent(self):
        return self.adapter._bot.send_message.await_args_list


@pytest.fixture
def batches(tmp_path, monkeypatch):
    target = tmp_path / "telegram-messages" / "batches"
    monkeypatch.setattr(telegram_triage, "BATCH_DIR", target)
    monkeypatch.setattr(telegram_triage, "CAPTURE_QUIET_SECONDS", 0.2)
    return lambda: sorted(target.glob("*.json")) if target.exists() else []


def _run(box, monkeypatch, *messages, settle=0.6):
    gateway = Gateway(monkeypatch)

    async def go():
        await gateway.start()
        await gateway.feed(*messages)
        await asyncio.sleep(settle)
        await gateway.runner._stop_all_person_bots()

    asyncio.run(go())
    return gateway


def _strangers():
    return (
        _message(10, "Hi, is John available?", sender=STRANGER, chat=STRANGER, chat_type="private"),
        _message(11, "It's about the HKD 12,000 invoice", sender=STRANGER, chat=STRANGER,
                 chat_type="private", minute=1),
        _message(5, "Shipment delayed", sender=OTHER, chat=GROUP, chat_type="supergroup", title="Suppliers"),
    )


def test_owner_dm_is_a_turn_and_strangers_become_batches(box, monkeypatch, batches):
    _config(box, "agent")
    source = _register(box)
    owner = _message(1, "what's on today?", sender=JOHN_TG, chat=JOHN_TG, chat_type="private")
    gateway = _run(box, monkeypatch, owner, *_strangers())

    (turn,) = gateway.runner.turns
    assert (turn.user_id, turn.account_id, turn.internal_user_id) == (JOHN_TG, ACCOUNT, "john")
    assert [c.kwargs.get("chat_id", c.args[0] if c.args else None) for c in gateway.sent] in (
        [int(JOHN_TG)], [JOHN_TG]), "only the owner gets a reply, through the receiving bot"

    paths = batches()
    assert [p.name for p in paths] == [f"tg_{BOT_ID}_{STRANGER}_10.json", f"tg_{BOT_ID}_m1004242_5.json"]
    dm, group = (json.loads(p.read_text()) for p in paths)
    assert dm == {
        "batch_id": f"tg_{BOT_ID}_{STRANGER}_10",
        "channel": "telegram",
        "source_id": source.source_id,
        "owner_user_id": "john",
        "account_id": ACCOUNT,
        "chat_id": STRANGER,
        "chat_type": "dm",
        "chat_title": f"User {STRANGER}",
        "created_at": dm["created_at"],
        "messages": [
            {"message_id": "10", "sender_id": STRANGER, "sender_name": f"User {STRANGER}",
             "sender_username": f"@u{STRANGER}", "text": "Hi, is John available?",
             "timestamp": "2026-11-16T08:00:00+00:00", "media": []},
            {"message_id": "11", "sender_id": STRANGER, "sender_name": f"User {STRANGER}",
             "sender_username": f"@u{STRANGER}", "text": "It's about the HKD 12,000 invoice",
             "timestamp": "2026-11-16T08:01:00+00:00", "media": []},
        ],
    }
    assert datetime.fromisoformat(dm["created_at"]).tzinfo is not None
    assert (group["chat_id"], group["chat_type"], group["chat_title"]) == (GROUP, "group", "Suppliers")
    assert [m["sender_id"] for m in group["messages"]] == [OTHER]
    assert group["source_id"] == source.source_id and group["owner_user_id"] == "john"


@pytest.mark.parametrize("case", ["off", "unrouted", "disabled", "unregistered", "registry_down"])
def test_strangers_are_ignored_unless_capture_is_on_and_routed(box, monkeypatch, batches, case):
    _config(box, "off" if case == "off" else "agent")
    if case == "unrouted":
        _register(box, routed=False)
    elif case == "disabled":
        _register(box, enabled=False)
    elif case != "unregistered":
        _register(box)
    if case == "registry_down":
        cfg = pg_config("postgresql://postgres:wrong@127.0.0.1:1/postgres")
        cfg["triage"] = {"agent": {"telegram": "agent"}}
        (box["homes"]["default"] / "config.yaml").write_text(yaml.safe_dump(cfg))
    owner = _message(1, "hello", sender=JOHN_TG, chat=JOHN_TG, chat_type="private")
    gateway = _run(box, monkeypatch, *_strangers(), owner)

    assert batches() == []
    assert [s.user_id for s in gateway.runner.turns] == ([] if case == "registry_down" else [JOHN_TG])
    assert len(gateway.sent) == len(gateway.runner.turns)
