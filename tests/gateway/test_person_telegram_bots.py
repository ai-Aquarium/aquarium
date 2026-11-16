"""Per-person Telegram bots in the gateway (gateway/person_telegram_bots.py):
which entries run, who may talk to a person's bot, which person a message is
handled as, which bot a reply leaves through, and that adding/removing one
person's bot leaves every other bot alone. Entries live in the real file
credential store under the test HERMES_HOME; adapters are fakes."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

from gateway.config import Platform
from gateway.person_telegram_bots import desired_person_bots
from gateway.session import SessionSource
from hermes_cli.access import Principal
from hermes_cli.credential_store import default_credential_store

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="admin")
ALICE_TOKEN = "111111111:AAalice" + "a" * 28
BOB_TOKEN = "222222222:AAbob" + "b" * 30
INSTALL_TOKEN = "999999999:AAinstall" + "i" * 26
ALICE_TG, BOB_TG = "5001", "5002"


def save(principal, token, linked=None):
    payload = {"token": token, "bot_id": token.split(":")[0]}
    if linked:
        payload["linked_user_id"] = linked
    asyncio.run(
        default_credential_store().put(
            principal, provider="telegram", name="bot", kind="telegram-bot",
            payload=payload, visibility=f"private:{principal.user_id}",
        )
    )


class FakePrincipalStore:
    async def get(self, user_id):
        return {"alice": ALICE, "bob": BOB}.get(user_id)


def make_runner(monkeypatch):
    from gateway.run import GatewayRunner

    runner = object.__new__(GatewayRunner)
    install = MagicMock(name="install-bot")
    runner.adapters = {Platform.TELEGRAM: install}
    runner.session_store = None
    runner._busy_text_mode = None
    runner._running = True
    runner.created = []
    runner.disconnected = []
    runner.handled = []

    def create(platform, config):
        adapter = MagicMock(name=config.extra["account_id"])
        adapter.config = config
        runner.created.append(adapter)
        return adapter

    async def connect(adapter, platform, **_):
        return True

    async def disconnect(adapter, platform):
        runner.disconnected.append(adapter)

    async def handle(event):
        runner.handled.append(event.source)
        return "ok"

    runner._create_adapter = create
    runner._connect_adapter_with_timeout = connect
    runner._safe_adapter_disconnect = disconnect
    runner._handle_message = handle
    runner._get_principal_store = lambda: FakePrincipalStore()
    runner._handle_active_session_busy_message = MagicMock()
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", INSTALL_TOKEN)
    return runner, install


def dm(account_id, user_id, chat_type="dm"):
    return SessionSource(
        platform=Platform.TELEGRAM, chat_id=user_id, chat_type=chat_type,
        user_id=user_id, account_id=account_id,
    )


def test_only_linked_entries_run_and_never_the_install_bot():
    entries = [
        SimpleNamespace(owner_user_id="alice", kind="telegram-bot", payload={"token": ALICE_TOKEN, "linked_user_id": ALICE_TG}),
        SimpleNamespace(owner_user_id="bob", kind="telegram-bot", payload={"token": BOB_TOKEN}),
        SimpleNamespace(owner_user_id="carol", kind="telegram-bot", payload={"token": INSTALL_TOKEN, "linked_user_id": "1"}),
    ]
    specs = desired_person_bots(entries, install_token=INSTALL_TOKEN)
    assert list(specs) == ["tgbot:111111111"]
    assert specs["tgbot:111111111"].owner_user_id == "alice"


def test_a_bot_saved_by_two_people_does_not_run():
    entries = [
        SimpleNamespace(owner_user_id=o, kind="telegram-bot", payload={"token": ALICE_TOKEN, "linked_user_id": t})
        for o, t in (("alice", ALICE_TG), ("bob", BOB_TG))
    ]
    assert desired_person_bots(entries) == {}


def test_fresh_install_runs_no_person_bot(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert runner.created == [] and runner._person_bots() == {}


def test_reconcile_starts_one_isolated_bot_per_person(monkeypatch):
    runner, install = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    bots = runner._person_bots()
    assert set(bots) == {"tgbot:111111111", "tgbot:222222222"}
    alice_cfg = bots["tgbot:111111111"].config
    assert alice_cfg.token == ALICE_TOKEN
    assert alice_cfg.extra["allow_from"] == [ALICE_TG]
    assert alice_cfg.extra["force_polling"] is True
    assert runner.adapters == {Platform.TELEGRAM: install}


def test_removing_one_bot_leaves_the_others_running(monkeypatch):
    runner, install = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    alice_bot = runner._person_bots()["tgbot:111111111"]
    bob_bot = runner._person_bots()["tgbot:222222222"]
    asyncio.run(default_credential_store().delete(BOB, "telegram", "bot"))
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert runner.disconnected == [bob_bot]
    assert runner._person_bots() == {"tgbot:111111111": alice_bot}
    assert len(runner.created) == 2
    install.disconnect.assert_not_called()
    # Adding Bob back starts only Bob's bot.
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert len(runner.created) == 3 and runner._person_bots()["tgbot:111111111"] is alice_bot


def test_unlinking_stops_the_bot(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    save(ALICE, ALICE_TOKEN)
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert runner._person_bots() == {}


def test_only_the_linked_telegram_id_in_a_private_chat_is_authorized(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    # Bob's Telegram id is on the install-wide allowlist: still not Alice's bot.
    monkeypatch.setenv("TELEGRAM_ALLOWED_USERS", f"{ALICE_TG},{BOB_TG}")
    assert runner._is_user_authorized(dm("tgbot:111111111", ALICE_TG)) is True
    assert runner._is_user_authorized(dm("tgbot:111111111", BOB_TG)) is False
    assert runner._is_user_authorized(dm("tgbot:111111111", ALICE_TG, "group")) is False
    assert runner._is_user_authorized(dm("tgbot:222222222", BOB_TG)) is False
    assert runner._person_bot_authorization(dm(None, BOB_TG)) is None


def test_message_to_alices_bot_is_handled_only_as_alice(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    handler = runner._make_person_bot_message_handler("tgbot:111111111")
    # The adapter would stamp its own account; a sender cannot pick another.
    forged = dm("tgbot:222222222", ALICE_TG)
    forged.internal_user_id = "bob"
    forged.internal_user_role = "admin"
    assert asyncio.run(handler(SimpleNamespace(source=forged))) == "ok"
    (source,) = runner.handled
    assert source.account_id == "tgbot:111111111"
    assert source.internal_user_id == "alice" and source.internal_user_role == "member"
    # Bob writing to Alice's bot is dropped, never handled as anyone.
    assert asyncio.run(handler(SimpleNamespace(source=dm(None, BOB_TG)))) is None
    assert len(runner.handled) == 1


def test_inactive_owner_is_not_served(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())

    class Inactive:
        async def get(self, user_id):
            return Principal(user_id="alice", display="A", role="member", active=False)

    runner._get_principal_store = lambda: Inactive()
    handler = runner._make_person_bot_message_handler("tgbot:111111111")
    assert asyncio.run(handler(SimpleNamespace(source=dm(None, ALICE_TG)))) is None
    assert runner.handled == []


def test_replies_leave_through_the_receiving_bot(monkeypatch):
    runner, install = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    alice_bot = runner._person_bots()["tgbot:111111111"]
    assert runner._source_adapter(dm("tgbot:111111111", ALICE_TG)) is alice_bot
    assert runner._source_adapter(dm(None, ALICE_TG)) is install
    # A stopped person bot never falls back to the install bot.
    assert runner._source_adapter(dm("tgbot:222222222", BOB_TG)) is None


# -- FG-03 P6: other senders' messages become triage batches ------------------

import json  # noqa: E402

import pytest  # noqa: E402

from hermes_cli import source_registry, telegram_triage  # noqa: E402
from hermes_cli.source_registry import Route, Source  # noqa: E402

STRANGER, OTHER = "7001", "7002"


def telegram_source(bot_id, owner, *, enabled=True, routes=(("cfo", True),)):
    return Source(
        source_id=f"src-{bot_id}", channel="telegram", address=bot_id, owner_user_id=owner,
        enabled=enabled, routes=tuple(Route(f"src-{bot_id}", slug, on) for slug, on in routes),
    )


@pytest.fixture
def capture(monkeypatch, tmp_path):
    """Capture on (``agent`` mode), Alice's bot routed; returns the knobs."""
    state = SimpleNamespace(mode="agent", sources=[telegram_source("111111111", "alice")],
                            fail=False, reads=0, dir=tmp_path / "batches")
    monkeypatch.setattr(telegram_triage, "mode", lambda config=None: state.mode)
    monkeypatch.setattr(telegram_triage, "BATCH_DIR", state.dir)
    monkeypatch.setattr(telegram_triage, "CAPTURE_QUIET_SECONDS", 0.05)

    class Conn:
        async def close(self):
            pass

    async def connect_box(**_):
        state.reads += 1
        if state.fail:
            raise OSError("registry down")
        return Conn()

    async def list_sources(connection, *, channel=None, owner_user_id=None):
        assert channel == "telegram"
        return list(state.sources)

    monkeypatch.setattr(source_registry, "connect_box", connect_box)
    monkeypatch.setattr(source_registry, "list_sources", list_sources)
    state.batches = lambda: sorted(state.dir.glob("*.json")) if state.dir.exists() else []
    return state


def record(sender=STRANGER, chat=None, message_id="10", text="hi", chat_type="dm", title="Stranger"):
    return {
        "chat_id": chat or sender, "chat_type": chat_type, "chat_title": title,
        "message_id": message_id, "sender_id": sender, "sender_name": "Sam Stranger",
        "sender_username": "@sam", "text": text, "timestamp": "2026-11-16T08:00:00+00:00", "media": [],
    }


def started(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    save(BOB, BOB_TOKEN, BOB_TG)
    return runner


def run_capture(runner, account_id, *records, settle=0.2):
    async def go():
        sink = runner._make_person_bot_capture(account_id)
        await runner._reconcile_person_telegram_bots()
        for rec in records:
            await sink(rec)
        await asyncio.sleep(settle)

    asyncio.run(go())


def test_person_bot_adapter_gets_a_capture_sink(monkeypatch):
    runner = started(monkeypatch)
    asyncio.run(runner._reconcile_person_telegram_bots())
    linked = {"tgbot:111111111": ALICE_TG, "tgbot:222222222": BOB_TG}
    for adapter in runner.created:
        assert adapter.config.extra["allow_from"] == [linked[adapter.config.extra["account_id"]]]
        adapter.set_refused_message_sink.assert_called_once()


def test_stranger_burst_in_one_chat_is_one_batch_in_the_contract_format(monkeypatch, capture):
    runner = started(monkeypatch)
    run_capture(runner, "tgbot:111111111",
                record(message_id="10", text="hello"), record(message_id="11", text="are you there?"),
                record(sender=OTHER, chat="-1009", chat_type="group", title="Suppliers", message_id="5"))
    assert runner.handled == []
    paths = capture.batches()
    assert [p.name for p in paths] == ["tg_111111111_7001_10.json", "tg_111111111_m1009_5.json"]
    dm_batch = json.loads(paths[0].read_text())
    assert set(dm_batch) == {"batch_id", "channel", "source_id", "owner_user_id", "account_id",
                             "chat_id", "chat_type", "chat_title", "created_at", "messages"}
    assert dm_batch["batch_id"] == telegram_triage.batch_id_for("111111111", STRANGER, "10")
    assert (dm_batch["channel"], dm_batch["source_id"], dm_batch["owner_user_id"]) == (
        "telegram", "src-111111111", "alice")
    assert (dm_batch["account_id"], dm_batch["chat_id"], dm_batch["chat_type"]) == (
        "tgbot:111111111", STRANGER, "dm")
    assert [m["text"] for m in dm_batch["messages"]] == ["hello", "are you there?"]
    assert set(dm_batch["messages"][0]) == {"message_id", "sender_id", "sender_name", "sender_username",
                                            "text", "timestamp", "media"}
    group = json.loads(paths[1].read_text())
    assert (group["chat_type"], group["chat_title"], group["chat_id"]) == ("group", "Suppliers", "-1009")
    assert not list(capture.dir.glob("*.tmp"))
    assert capture.reads == 1, "the registry answer is cached"


def test_batch_closes_at_the_size_cap_and_duplicates_are_dropped(monkeypatch, capture):
    monkeypatch.setattr(telegram_triage, "CAPTURE_MAX_MESSAGES", 2)
    runner = started(monkeypatch)
    run_capture(runner, "tgbot:111111111", record(message_id="1"), record(message_id="1"),
                record(message_id="2"), record(message_id="3"))
    batches = [json.loads(p.read_text()) for p in capture.batches()]
    assert [[m["message_id"] for m in b["messages"]] for b in batches] == [["1", "2"], ["3"]]


@pytest.mark.parametrize("change", ["off", "unrouted", "route_off", "disabled", "down", "not_a_source",
                                    "other_owner"])
def test_others_are_ignored_unless_on_and_routed(monkeypatch, capture, change):
    if change == "off":
        capture.mode = "off"
    elif change == "unrouted":
        capture.sources = [telegram_source("111111111", "alice", routes=())]
    elif change == "route_off":
        capture.sources = [telegram_source("111111111", "alice", routes=(("cfo", False),))]
    elif change == "disabled":
        capture.sources = [telegram_source("111111111", "alice", enabled=False)]
    elif change == "down":
        capture.fail = True
    elif change == "not_a_source":
        capture.sources = [telegram_source("222222222", "bob")]
    elif change == "other_owner":
        capture.sources = [telegram_source("111111111", "bob")]
    runner = started(monkeypatch)
    run_capture(runner, "tgbot:111111111", record(), record(message_id="11"))
    assert capture.batches() == [] and runner.handled == []
    assert capture.reads == (0 if change == "off" else 1)


def test_owner_messages_are_never_captured_and_still_handled_as_owner(monkeypatch, capture):
    runner = started(monkeypatch)
    run_capture(runner, "tgbot:111111111", record(sender=ALICE_TG))
    assert capture.batches() == []
    handler = runner._make_person_bot_message_handler("tgbot:111111111")
    assert asyncio.run(handler(SimpleNamespace(source=dm(None, ALICE_TG)))) == "ok"
    assert asyncio.run(handler(SimpleNamespace(source=dm(None, STRANGER)))) is None
    assert asyncio.run(handler(SimpleNamespace(source=dm(None, STRANGER, chat_type="group")))) is None
    assert [s.internal_user_id for s in runner.handled] == ["alice"]


def test_stopping_a_bot_writes_its_open_batches(monkeypatch, capture):
    monkeypatch.setattr(telegram_triage, "CAPTURE_QUIET_SECONDS", 60)
    runner = started(monkeypatch)
    run_capture(runner, "tgbot:111111111", record(), settle=0)
    assert capture.batches() == []
    asyncio.run(runner._stop_all_person_bots())
    assert [p.name for p in capture.batches()] == ["tg_111111111_7001_10.json"]


def flaky_writes(monkeypatch, fail_first):
    """``write_batch`` that fails the first ``fail_first`` calls; returns the call log."""
    calls = []
    real = telegram_triage.write_batch

    def write(batch, *, batch_dir=None):
        calls.append(batch["batch_id"])
        if len(calls) <= fail_first:
            raise OSError("disk full")
        return real(batch, batch_dir=batch_dir)

    monkeypatch.setattr(telegram_triage, "write_batch", write)
    return calls


def test_a_failed_write_is_retried_and_no_message_is_lost(monkeypatch, capture):
    import gateway.person_telegram_bots as bots

    monkeypatch.setattr(bots, "_RETRY_FIRST_SECONDS", 0.1)
    calls = flaky_writes(monkeypatch, fail_first=1)
    runner = started(monkeypatch)

    async def go():
        sink = runner._make_person_bot_capture("tgbot:111111111")
        await runner._reconcile_person_telegram_bots()
        await sink(record(message_id="10", text="invoice 1"))
        await sink(record(message_id="11", text="invoice 2"))
        await asyncio.sleep(0.08)  # first write failed, retry not due yet
        assert capture.batches() == []
        await sink(record(message_id="12", text="invoice 3"))  # a new batch, separate from the failed one
        await asyncio.sleep(0.4)

    asyncio.run(go())
    batches = {p.name: json.loads(p.read_text()) for p in capture.batches()}
    assert sorted(batches) == ["tg_111111111_7001_10.json", "tg_111111111_7001_12.json"]
    assert [m["text"] for m in batches["tg_111111111_7001_10.json"]["messages"]] == ["invoice 1", "invoice 2"]
    assert [m["text"] for m in batches["tg_111111111_7001_12.json"]["messages"]] == ["invoice 3"]
    assert calls.count("tg_111111111_7001_10") == 2
    assert runner._person_bot_capture_state()["retry"] == {}


def test_stopping_a_bot_writes_batches_still_waiting_for_a_retry(monkeypatch, capture):
    flaky_writes(monkeypatch, fail_first=1)
    runner = started(monkeypatch)
    run_capture(runner, "tgbot:111111111", record())
    assert capture.batches() == [] and len(runner._person_bot_capture_state()["retry"]) == 1
    asyncio.run(runner._stop_all_person_bots())
    assert [p.name for p in capture.batches()] == ["tg_111111111_7001_10.json"]
    assert runner._person_bot_capture_state()["retry"] == {}


def test_stop_also_writes_a_chat_that_arrives_while_another_chats_write_is_running(monkeypatch, capture):
    import threading

    monkeypatch.setattr(telegram_triage, "CAPTURE_QUIET_SECONDS", 60)
    real = telegram_triage.write_batch
    writing, release = threading.Event(), threading.Event()

    def slow_write(batch, *, batch_dir=None):
        if batch["chat_id"] == STRANGER:
            writing.set()
            assert release.wait(5)
        return real(batch, batch_dir=batch_dir)

    monkeypatch.setattr(telegram_triage, "write_batch", slow_write)
    runner = started(monkeypatch)

    async def go():
        sink = runner._make_person_bot_capture("tgbot:111111111")
        await runner._reconcile_person_telegram_bots()
        await sink(record())
        stop = asyncio.create_task(runner._stop_all_person_bots())
        while not writing.is_set():
            await asyncio.sleep(0.01)
        # Delivered by the adapter while chat A's write is suspended.
        await sink(record(sender=OTHER, chat="-1009", chat_type="group", title="Suppliers", message_id="5"))
        release.set()
        await stop

    asyncio.run(go())
    assert [p.name for p in capture.batches()] == ["tg_111111111_7001_10.json", "tg_111111111_m1009_5.json"]
    assert runner.handled == []


def test_a_batch_that_failed_many_times_is_still_retried_at_the_max_delay(monkeypatch, capture):
    import gateway.person_telegram_bots as bots

    runner = started(monkeypatch)
    delays = []

    async def later(failed, delay):
        delays.append(delay)

    monkeypatch.setattr(runner, "_retry_person_bot_batch_later", later)

    async def go():
        failed = bots._FailedBatch("tgbot:111111111", {"batch_id": "tg_1_2_3"}, attempts=5000)
        runner._queue_person_bot_batch_retry(failed)
        assert failed.task is not None
        await failed.task

    asyncio.run(go())
    assert delays == [bots._RETRY_MAX_SECONDS]
    assert bots._retry_delay(1) == bots._RETRY_FIRST_SECONDS


def test_stop_writes_each_batch_exactly_once_even_when_a_retry_comes_due_mid_drain(monkeypatch, capture):
    import threading

    import gateway.person_telegram_bots as bots

    monkeypatch.setattr(bots, "_RETRY_FIRST_SECONDS", 0.3)
    real = telegram_triage.write_batch
    calls, writing, release = [], threading.Event(), threading.Event()

    def write(batch, *, batch_dir=None):
        calls.append(batch["batch_id"])
        if len(calls) == 1:
            raise OSError("disk full")
        if batch["chat_id"] == "-1009":
            writing.set()
            assert release.wait(5)
        return real(batch, batch_dir=batch_dir)

    monkeypatch.setattr(telegram_triage, "write_batch", write)
    runner = started(monkeypatch)

    async def go():
        sink = runner._make_person_bot_capture("tgbot:111111111")
        await runner._reconcile_person_telegram_bots()
        await sink(record())
        await asyncio.sleep(0.15)  # chat A's write failed; its retry is due at ~0.35 s
        assert len(runner._person_bot_capture_state()["retry"]) == 1
        monkeypatch.setattr(telegram_triage, "CAPTURE_QUIET_SECONDS", 60)
        await sink(record(sender=OTHER, chat="-1009", chat_type="group", title="Suppliers", message_id="5"))
        stop = asyncio.create_task(runner._stop_all_person_bots())
        while not writing.is_set():
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.4)  # chat A's retry comes due while chat B's write is suspended
        release.set()
        await stop

    asyncio.run(go())
    assert calls == ["tg_111111111_7001_10", "tg_111111111_m1009_5", "tg_111111111_7001_10"]
    assert [p.name for p in capture.batches()] == ["tg_111111111_7001_10.json", "tg_111111111_m1009_5.json"]
