"""FG-03 P6 E2E: the real Telegram triage script, per triage.agent.telegram.

Real profiles over a tmp hermes root (John and Mary in CFO and CMO), the real
box registry, router and layered triage skills on real Postgres, the real
``custom/telegram/triage_agent.py`` and handlers. ``config.yaml`` sets the
router and agent modes and the script reads it itself. Only the models are
stand-ins: the cheap router model and the profile agent's turn.
"""

import asyncio
import json
import sys
from pathlib import Path

import asyncpg
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom"))

from hermes_cli import source_registry as registry  # noqa: E402
from hermes_cli import telegram_triage  # noqa: E402
from hermes_cli import todo_outbound  # noqa: E402
from hermes_cli import triage_agent as ta  # noqa: E402
from hermes_cli import triage_router as tr  # noqa: E402
from hermes_cli import triage_skills as tsk  # noqa: E402
from hermes_cli.datastore import app_schema  # noqa: E402
from tests.custom.test_fg03_batch_routing import _exec, credit  # noqa: E402,F401
from tests.custom.test_fg03_profile_triage_e2e import (  # noqa: E402
    JOHN_CHAT,
    NOTHING,
    Turns,
    _arrival_entries,
    _decisions,
    _profile_rows,
    _stores,
)
from tests.hermes_cli._pg_fixture import hermes_root, pg_config, postgres_dsn  # noqa: E402,F401
from tests.hermes_cli.test_source_registry_e2e import _box, _seed, box  # noqa: E402,F401
from tests.hermes_cli.test_triage_router_e2e import KeywordModel  # noqa: E402

TG_TRIAGE = ROOT / "custom" / "telegram" / "triage_agent.py"
BOT = "4242"
CHAT = "-100777"
TEXT = {
    "invoice": "Invoice INV-77 is overdue",           # CFO only
    "launch": "Launch plan and the agency invoice",   # CFO and CMO
    "chat": "Are we on for Friday?",                  # nobody
}


def _configure(hermes_root, router, agent):  # noqa: F811
    path = hermes_root / "config.yaml"
    config = yaml.safe_load(path.read_text()) or {}
    config["triage"] = {"router": {"mode": router, "retry_delay_seconds": 0}}
    if agent is not None:
        config["triage"]["agent"] = {"telegram": agent}
    path.write_text(yaml.safe_dump(config))


def _people(box):  # noqa: F811
    """John and Mary in CFO and CMO; John's Telegram bot routed to both."""
    homes = box["homes"]
    _box(box["dsn"], lambda c: registry.list_sources(c))  # box schema
    asyncio.run(_seed(homes["cmo"], box["dsn"], [("mary", "member", True)]))
    for profile in ("cfo", "cmo"):
        for user in ("john", "mary"):
            tsk.write_care("telegram", f"{user.title()}@{profile.upper()}: invoices and launches",
                           layer="user", home=homes[profile], user_id=user, author=user)

    async def setup(c):
        src = await registry.register_source(c, channel="telegram", address=f"tgbot:{BOT}",
                                             owner_user_id="john")
        for profile in ("cfo", "cmo"):
            await registry.set_route(c, source_id=src.source_id, profile_slug=profile,
                                     enabled=True, actor_user_id="john")
        return src.source_id

    return _box(box["dsn"], setup)


def _failed_notices(box):  # noqa: F811
    """Per profile: (owner, dedupe key) of every "could not be triaged" notice."""
    async def read():
        conn = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            return {p: [tuple(r) for r in await conn.fetch(
                f"SELECT owner_user_id, dedupe_key FROM {app_schema('prod', profile=p)}"
                ".notifications WHERE dedupe_key LIKE 'triage-failed:%'")]
                for p in ("default", "cfo", "cmo")}
        finally:
            await conn.close()

    return asyncio.run(read())


def _arrivals(box, profile):  # noqa: F811
    async def read():
        conn = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            schema = app_schema("prod", profile=profile)
            return [dict(r) for r in await conn.fetch(
                f"SELECT * FROM {schema}.inbound_items ORDER BY external_id")]
        finally:
            await conn.close()

    return asyncio.run(read())


class Telegram:
    """The real Telegram triage script over tmp batch dirs."""

    def __init__(self, tmp_path, source_id):
        self.module = _exec(TG_TRIAGE, {}, "_fg03p6_telegram_triage")
        self.batch_dir = tmp_path / "telegram-messages" / "batches"
        self.processed = tmp_path / "telegram-messages" / "processed"
        self.batch_dir.mkdir(parents=True)
        self.module.BATCH_DIR, self.module.PROCESSED_DIR = str(self.batch_dir), str(self.processed)
        self.source_id = source_id

    def write(self, name, text=None, source_id=...):
        first = {"invoice": "11", "launch": "21", "chat": "31"}.get(name, "41")
        batch = {
            "batch_id": telegram_triage.batch_id_for(BOT, CHAT, first),
            "channel": "telegram",
            "source_id": self.source_id if source_id is ... else source_id,
            "owner_user_id": "john",
            "account_id": f"{telegram_triage.ACCOUNT_PREFIX}{BOT}",
            "chat_id": CHAT, "chat_type": "group", "chat_title": "Suppliers",
            "created_at": "2026-11-16T08:00:00Z",
            "messages": [{"message_id": first, "sender_id": "9001", "sender_name": "Ann",
                          "sender_username": "ann", "text": TEXT.get(name, text or ""),
                          "timestamp": "2026-11-16T08:00:00Z", "media": []}],
        }
        return telegram_triage.write_batch(batch, batch_dir=self.batch_dir)

    def run(self):
        return self.module.run_pass()

    def done(self, path):
        return (self.processed / path.name).exists() and not path.exists()


@pytest.fixture
def setup(box, hermes_root, tmp_path, monkeypatch, credit):  # noqa: F811
    """``setup(router, agent, fail)`` -> (telegram, router model, turns, pushes)."""
    sent = _stores(box, monkeypatch)

    def make(router="enforce", agent="agent", fail=()):
        source_id = _people(box)
        _configure(hermes_root, router, agent)
        model = KeywordModel()
        monkeypatch.setattr(tr, "_AuxiliaryLLM", lambda: model)
        turns = Turns(fail)
        monkeypatch.setattr(ta, "_default_runner", turns)
        return Telegram(tmp_path, source_id), model, turns, sent

    return make


@pytest.mark.parametrize("agent", [None, "off"])
def test_off_leaves_batches_untouched(setup, agent):
    tg, model, turns, sent = setup(agent=agent)
    path = tg.write("launch")
    before = path.read_bytes()
    assert tg.run() == 0
    assert path.read_bytes() == before and not tg.processed.exists()
    assert model.calls == [] and turns.calls == [] and sent == []


def test_routed_to_johns_chosen_profiles_only(setup, box, monkeypatch):  # noqa: F811
    tg, model, turns, sent = setup()
    launch, invoice = tg.write("launch"), tg.write("invoice")
    assert tg.run() == 2
    assert tg.done(launch) and tg.done(invoice)
    assert len(model.calls) == 2  # one router call per batch
    launch_id = json.loads((tg.processed / launch.name).read_text())["batch_id"]
    assert sorted(turns.calls) == sorted([
        ("cfo", "john", f"triage_telegram_{launch_id}_cfo"),
        ("cmo", "john", f"triage_telegram_{launch_id}_cmo"),
        ("cfo", "john", f"triage_telegram_{telegram_triage.batch_id_for(BOT, CHAT, '11')}_cfo"),
    ])
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77")] * 2
    assert rows["cmo"]["todos"] == [("john", "Pay INV-77")]
    assert rows["default"] == NOTHING
    for profile in ("cfo", "cmo"):
        assert {owner for owner, _ in rows[profile]["notifications"]} == {"john"}  # never Mary
    assert set(sent) <= {JOHN_CHAT}  # the owner's own chat only, never the box chat
    assert _arrival_entries(monkeypatch, "mary") == []

    # The registered arrival carries the reply route: that bot, that chat.
    [arrival] = [a for a in _arrivals(box, "cmo") if a["external_id"] == f"{CHAT}:21"]
    assert (arrival["surface"], arrival["account_id"], arrival["owner_user_id"]) == (
        "telegram", f"tgbot:{BOT}", "john")
    assert todo_outbound.target_from_arrival(arrival) == {
        "channel": "telegram", "target": CHAT, "account_id": f"tgbot:{BOT}"}

    # A rerun of the same batch reuses the stored decision.
    path = tg.write("launch")
    tg.run()
    assert len(model.calls) == 2


def test_no_pick_is_stored_only(setup, box):  # noqa: F811
    tg, model, turns, sent = setup(router="enforce")
    path = tg.write("chat")
    tg.run()
    assert tg.done(path) and len(model.calls) == 1 and turns.calls == []
    assert list(_decisions(box).values()) == [[]]
    assert _profile_rows(box) == {p: NOTHING for p in ("default", "cfo", "cmo")}
    assert sent == []


def test_retry_runs_only_the_failed_profile(setup, box):  # noqa: F811
    tg, model, turns, sent = setup(fail={"cmo"})
    path = tg.write("launch")
    tg.run()
    batch = json.loads(path.read_text())
    assert batch["_profiles_done"] == ["cfo"] and batch["_agent_attempts"] == 1
    turns.fail.clear()
    tg.run()
    assert tg.done(path) and turns.profiles() == ["cfo", "cmo", "cmo"]
    assert len(model.calls) == 1
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77")] == rows["cmo"]["todos"]
    assert _failed_notices(box) == {"default": [], "cfo": [], "cmo": []}


@pytest.mark.parametrize("fail", [{"cmo"}, {"cfo", "cmo"}])
def test_cap_stores_the_batch_and_tells_the_owner_once(setup, box, fail):  # noqa: F811
    tg, model, turns, sent = setup(fail=fail)
    path = tg.write("launch")
    for attempt in (1, 2):
        tg.run()
        assert not tg.done(path)
        assert json.loads(path.read_text())["_agent_attempts"] == attempt
    pushes = list(sent)
    tg.run()
    assert tg.done(path) and len(model.calls) == 1
    stored = json.loads((tg.processed / path.name).read_text())
    assert stored["_agent_attempts"] == 3 and stored["messages"][0]["text"] == TEXT["launch"]
    notices = _failed_notices(box)
    first_failed = sorted(fail)[0]
    assert notices[first_failed] == [("john", f"triage-failed:telegram:{stored['batch_id']}")]
    assert sum(len(v) for v in notices.values()) == 1
    assert sent == pushes  # in-app only: no Telegram push for the failure
    if fail == {"cfo", "cmo"}:
        assert sent == [] and _profile_rows(box)["cfo"]["todos"] == []
    tg.run()  # nothing left: no second notice
    assert sum(len(v) for v in _failed_notices(box).values()) == 1


@pytest.mark.parametrize("router", ["off", "registry-down"])
def test_without_a_decision_the_batch_waits_then_is_stored(setup, box, router, monkeypatch):  # noqa: F811
    tg, model, turns, sent = setup(router="off" if router == "off" else "enforce")
    if router == "registry-down":
        monkeypatch.setattr(registry, "box_dsn",
                            lambda config=None: "postgresql://nobody@127.0.0.1:1/none")
    path = tg.write("launch")
    for attempt in (1, 2):
        tg.run()
        assert not tg.done(path) and json.loads(path.read_text())["_agent_attempts"] == attempt
    tg.run()
    assert tg.done(path) and turns.calls == [] and model.calls == [] and sent == []
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == rows["cmo"]["todos"] == []
    assert sum(len(v) for v in _failed_notices(box).values()) <= 1


def test_routing_link_and_decision_summary(setup, box, monkeypatch):  # noqa: F811
    tg, model, turns, sent = setup()
    path = tg.write("invoice")
    assert tg.run() == 1 and tg.done(path)
    batch_id = telegram_triage.batch_id_for(BOT, CHAT, "11")

    async def read(c):
        rows = await c.fetch(
            f"SELECT routing_source_id, routing_batch_id "
            f"FROM {app_schema('prod', profile='cfo')}.tasks")
        decision = await tr.get_decision(c, tg.source_id, batch_id)
        return [tuple(r) for r in rows], decision

    todos, decision = _box(box["dsn"], read)
    assert todos == [(tg.source_id, batch_id)]
    assert (decision.message_count, decision.first_sender) == (1, "Ann <@ann>")
    assert "INV-77" not in json.dumps(decision.as_dict())
