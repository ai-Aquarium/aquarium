"""FG-03 P5 E2E: the real email/WhatsApp triage scripts, per triage.agent.<channel>.

Real profiles over a tmp hermes root (John and Mary in CFO and CMO), the real
box registry, router, comparisons store and layered triage skills on real
Postgres, the real triage scripts and handlers over real SQLite channel
stores. ``config.yaml`` sets the router and agent modes and the scripts read
it themselves. Only the models are stand-ins: the cheap router model, the
profile agent's turn, and DeepSeek.
"""

import asyncio
import json
import sqlite3
import sys
from pathlib import Path

import asyncpg
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom"))

import hermes_cli.datastore as datastore  # noqa: E402
from hermes_cli import needs_you as ny  # noqa: E402
from hermes_cli import source_registry as registry  # noqa: E402
from hermes_cli import triage_agent as ta  # noqa: E402
from hermes_cli import triage_router as tr  # noqa: E402
from hermes_cli import triage_skills as tsk  # noqa: E402
from hermes_cli.access import PrincipalStore  # noqa: E402
from hermes_cli.console_scope import _scoped_to  # noqa: E402
from hermes_cli.datastore import app_schema, get_store  # noqa: E402
from hermes_cli.human_comms import NotificationStore  # noqa: E402
from hermes_cli.inbound_registry import InboundRegistry  # noqa: E402
from hermes_cli.todo_store import TodoStore  # noqa: E402
from tests.custom.test_fg03_batch_routing import (  # noqa: E402,F401 — pytest fixture
    EMAIL_TRIAGE,
    WA_TRIAGE,
    _exec,
    credit,
)
from tests.hermes_cli._pg_fixture import hermes_root, pg_config, postgres_dsn  # noqa: E402,F401
from tests.hermes_cli.test_source_registry_e2e import (  # noqa: E402,F401 — pytest fixture
    _box,
    _client,
    _seed,
    _session_as,
    box,
)
from tests.hermes_cli.test_triage_router_e2e import KeywordModel  # noqa: E402

JOHN_CHAT = "777"
BOX_CHAT = "111"

ADDRESS = {"email": "john@example.com", "whatsapp": "85291234567"}
TEXT = {
    "b-invoice": "Invoice INV-77 is overdue",           # CFO only
    "b-launch": "Launch plan and the agency invoice",   # CFO and CMO
    "b-chat": "Are we on for Friday?",                  # nobody
}
LEGACY = {"classification": "legacy", "summary": "legacy verdict", "escalate": True,
          "escalation_reason": "legacy", "escalation_priority": "high",
          "tasks": [{"description": "legacy task"}], "notes": [{"content": "legacy note"}],
          "todos": [{"title": "Legacy to-do", "priority": "high", "notify": True}]}


def agent_reply(profile):
    return {"classification": f"agent-{profile}", "summary": f"{profile} verdict",
            "escalate": True, "escalation_reason": "invoice", "escalation_priority": "high",
            "tasks": [{"description": "pay INV-77"}], "notes": [{"content": "INV-77 overdue"}],
            "todos": [{"title": "Pay INV-77", "priority": "high", "notify": True}]}


class DeepSeek:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def __call__(self, messages, **kwargs):
        self.calls.append(messages[-1]["content"])
        return None if self.fail else json.dumps(LEGACY)


class Turns:
    """The profile agent's turn: answers per profile, or fails on demand."""

    def __init__(self, fail=()):
        self.calls, self.fail = [], set(fail)

    def __call__(self, prompt, *, profile_home, owner_user_id, session_id, config=None):
        profile = profile_home.name
        self.calls.append((profile, owner_user_id, session_id))
        if profile in self.fail:
            raise RuntimeError("provider 503")
        return f"```json\n{json.dumps(agent_reply(profile))}\n```"

    def profiles(self):
        return [c[0] for c in self.calls]


SQLITE_MESSAGING = """
CREATE TABLE escalations (
    id TEXT PRIMARY KEY, source_phone TEXT, source_msg_id TEXT, sender_phone TEXT,
    reason TEXT, summary TEXT, priority TEXT, status TEXT, created_at TEXT,
    delivered_at TEXT, channel TEXT, sender_email TEXT, sender_name TEXT, contact_id INTEGER);
CREATE TABLE wa_tasks (id TEXT, source_phone TEXT, source_msg_id TEXT, description TEXT,
    due_date TEXT, status TEXT, priority TEXT, created_at TEXT);
CREATE TABLE wa_notes (id TEXT, source_phone TEXT, source_msg_id TEXT, content TEXT,
    created_at TEXT);
CREATE TABLE contact_handles (contact_id INTEGER, handle_type TEXT, handle_value TEXT);
CREATE TABLE unified_contacts (id INTEGER PRIMARY KEY, display_name TEXT,
    is_family INTEGER, is_vip INTEGER);
"""
SQLITE_EMAIL = """
CREATE TABLE email_tasks (id TEXT, account_id TEXT, source_email_id TEXT, description TEXT,
    due_date TEXT, status TEXT, priority TEXT, created_at TEXT);
CREATE TABLE email_notes (id TEXT, account_id TEXT, source_email_id TEXT, content TEXT,
    created_at TEXT);
"""


class Channel:
    """One real triage script over tmp roots and real SQLite stores."""

    def __init__(self, kind, tmp_path, monkeypatch):
        self.kind = kind
        self.messaging = tmp_path / "msg" / "messaging_data.db"
        self.messaging.parent.mkdir()
        _sqlite(self.messaging, SQLITE_MESSAGING)
        monkeypatch.setenv("MESSAGING_DB_PATH", str(self.messaging))
        if kind == "email":
            root = tmp_path / "email-messages"
            root.mkdir()
            (root / "config.json").write_text("{}")
            self.store = root / "email_data.db"
            _sqlite(self.store, SQLITE_EMAIL)
            monkeypatch.setenv("EMAIL_DB_PATH", str(self.store))
            monkeypatch.setitem(sys.modules, "contact_manager", None)
            self.module = _exec(EMAIL_TRIAGE, {"/opt/data/email-messages": str(root)},
                                "_fg03p5_email_triage")
            self.batch_dir, self.processed = self.module.EMAIL_BATCH_DIR, self.module.EMAIL_PROCESSED_DIR
            self.tasks, self.notes = "email_tasks", "email_notes"
        else:
            root = tmp_path / "whatsapp-messages"
            root.mkdir()
            (root / "config.json").write_text("{}")
            self.store = self.messaging
            self.module = _exec(WA_TRIAGE, {"/opt/data/whatsapp-messages": str(root)},
                                "_fg03p5_wa_triage")
            self.batch_dir, self.processed = self.module.BATCH_DIR, self.module.PROCESSED_DIR
            self.tasks, self.notes = "wa_tasks", "wa_notes"
        self.deepseek = DeepSeek()
        monkeypatch.setattr(self.module, "call_deepseek", self.deepseek)

    def write(self, batch_id, source_id, sender=None, text=None):
        text = TEXT.get(batch_id, "") if text is None else text
        if self.kind == "email":
            sender = sender or "supplier@example.com"
            batch = {"batch_id": batch_id, "channel": "email", "account_id": ADDRESS["email"],
                     "source_id": source_id, "owner_user_id": "john", "sender": sender,
                     "sender_name": "Supplier", "email_count": 1,
                     "emails": [{"id": f"{batch_id}-e1", "message_id": f"<{batch_id}@x>",
                                 "from_addr": sender,
                                 "subject": "Re: things", "body_text": text}]}
        else:
            batch = {"batch_id": batch_id, "sender_phone": "+85211112222",
                     "source_phone": "phone2", "source_id": source_id,
                     "owner_user_id": "john", "message_count": 1,
                     "messages": [{"msg_id": f"{batch_id}-m1", "text": text,
                                   "sender_name": "Supplier", "chat_id": "111@lid",
                                   "is_group": False}]}
        path = Path(self.batch_dir) / f"{batch_id}.json"
        path.write_text(json.dumps(batch))
        return path

    def run(self, path):
        if self.kind == "email":
            self.module.process_email_batch_file(str(path))
        else:
            self.module.process_batch_file(str(path))

    def done(self, path):
        return Path(self.processed, path.name).exists() and not path.exists()

    def rows(self, table):
        db = sqlite3.connect(self.messaging if table == "escalations" else self.store)
        try:
            return [r[0] for r in db.execute(
                f"SELECT {'summary' if table == 'escalations' else 'description' if 'tasks' in table else 'content'} "
                f"FROM {table} ORDER BY rowid")]
        finally:
            db.close()

    def box_rows(self):
        return {t: self.rows(t) for t in ("escalations", self.tasks, self.notes)}


def _sqlite(path, script):
    db = sqlite3.connect(path)
    db.executescript(script)
    db.commit()
    db.close()


def _configure(hermes_root, router, agent):  # noqa: F811
    path = hermes_root / "config.yaml"
    config = yaml.safe_load(path.read_text()) or {}
    config["triage"] = {"router": {"mode": router, "retry_delay_seconds": 0},
                        "agent": {"email": agent, "whatsapp": agent}}
    path.write_text(yaml.safe_dump(config))


def _stores(box, monkeypatch):  # noqa: F811
    """Each profile's to-do, inbox and notification stores; John's Telegram in CFO and CMO."""
    config = pg_config(box["dsn"])

    async def init(home, link):
        with _scoped_to(home):
            app = get_store("supabase-app", "prod", config=config)
            await InboundRegistry(app).initialize()
            await TodoStore(app).initialize()
            await NotificationStore(app, config=config).initialize()
            if link:
                await PrincipalStore(app).link_channel("john", "telegram", JOHN_CHAT)

    for profile in ("default", "cfo", "cmo"):
        asyncio.run(init(box["homes"][profile], profile != "default"))
    datastore._verified_schemas.clear()
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token")
    monkeypatch.setenv("TELEGRAM_ALLOWED_USERS", BOX_CHAT)
    from shared import escalation_pusher_v2, inbound_registration, todo_registration

    for module in (inbound_registration, todo_registration):
        monkeypatch.setattr(module, "_owner_principal", None)
        monkeypatch.setattr(module, "_owner_resolved", False)
        monkeypatch.setattr(module, "_owner_last_attempt", float("-inf"))
    sent = []
    monkeypatch.setattr(escalation_pusher_v2, "send_telegram",
                        lambda text, parse_mode="HTML", chat_id=None: sent.append(chat_id) or True)
    return sent


def _profile_rows(box):  # noqa: F811
    """Per profile: (owner, title) of every to-do and (owner, base key) of every notification."""
    async def read():
        conn = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            out = {}
            for profile in ("default", "cfo", "cmo"):
                schema = app_schema("prod", profile=profile)
                out[profile] = {
                    "todos": [tuple(r) for r in await conn.fetch(
                        f"SELECT owner_user_id, title FROM {schema}.tasks ORDER BY created_at")],
                    "notifications": sorted(tuple(r) for r in await conn.fetch(
                        f"SELECT owner_user_id, split_part(dedupe_key, ':', 1) "
                        f"FROM {schema}.notifications")),
                }
            return out
        finally:
            await conn.close()

    return asyncio.run(read())


NOTHING = {"todos": [], "notifications": []}


def _people(box, kind):  # noqa: F811
    """John and Mary in CFO and CMO; John's source routed to both."""
    homes = box["homes"]
    _box(box["dsn"], lambda c: registry.list_sources(c))  # box schema
    asyncio.run(_seed(homes["cmo"], box["dsn"], [("mary", "member", True)]))
    for profile in ("cfo", "cmo"):
        for user in ("john", "mary"):
            tsk.write_care(kind, f"{user.title()}@{profile.upper()}: invoices and launches",
                           layer="user", home=homes[profile], user_id=user, author=user)

    async def setup(c):
        src = await registry.register_source(c, channel=kind, address=ADDRESS[kind],
                                             owner_user_id="john")
        for profile in ("cfo", "cmo"):
            await registry.set_route(c, source_id=src.source_id, profile_slug=profile,
                                     enabled=True, actor_user_id="john")
        return src.source_id

    return _box(box["dsn"], setup)


def _comparisons(box, **filters):  # noqa: F811
    async def rows(c):
        return list(reversed(await ta.list_comparisons(c, **filters)))

    return _box(box["dsn"], rows)


def _decisions(box):  # noqa: F811
    async def rows(c):
        return {r["batch_id"]: list(r["selected"]) for r in await c.fetch(
            f"SELECT batch_id, selected FROM {registry.BOX_SCHEMA}.routing_decisions")}

    return _box(box["dsn"], rows)


@pytest.fixture(params=["email", "whatsapp"])
def setup(request, box, hermes_root, tmp_path, monkeypatch, credit):  # noqa: F811
    """``setup(router, agent)`` -> (channel, source_id, router model, turns)."""
    kind = request.param
    sent = _stores(box, monkeypatch)

    def make(router="enforce", agent="legacy", fail=()):
        source_id = _people(box, kind)
        _configure(hermes_root, router, agent)
        model = KeywordModel()
        monkeypatch.setattr(tr, "_AuxiliaryLLM", lambda: model)
        turns = Turns(fail)
        monkeypatch.setattr(ta, "_default_runner", turns)
        channel = Channel(kind, tmp_path, monkeypatch)
        channel.sent = sent
        return channel, source_id, model, turns

    return make


def test_legacy_is_unchanged(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="shadow", agent="legacy")
    paths = [ch.write(b, source_id) for b in TEXT]
    for path in paths:
        ch.run(path)
    assert len(model.calls) == len(TEXT)  # one router call per batch
    assert len(ch.deepseek.calls) == len(TEXT) and turns.calls == []
    assert ch.box_rows() == {"escalations": ["legacy verdict"] * 3,
                             ch.tasks: ["legacy task"] * 3, ch.notes: ["legacy note"] * 3}
    assert _comparisons(box) == []
    assert all(ch.done(p) for p in paths)


def test_shadow_acts_on_legacy_and_stores_comparisons(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="shadow", agent="shadow")
    paths = [ch.write(b, source_id) for b in TEXT]
    for path in paths:
        ch.run(path)
    assert len(model.calls) == len(TEXT)
    assert len(ch.deepseek.calls) == len(TEXT)
    assert ch.box_rows() == {"escalations": ["legacy verdict"] * 3,
                             ch.tasks: ["legacy task"] * 3, ch.notes: ["legacy note"] * 3}
    assert turns.calls == [("cfo", "john", f"triage_{ch.kind}_b-invoice_cfo"),
                           ("cfo", "john", f"triage_{ch.kind}_b-launch_cfo"),
                           ("cmo", "john", f"triage_{ch.kind}_b-launch_cmo")]
    stored = _comparisons(box)
    assert [(c["batch_id"], c["profile"], c["owner_user_id"]) for c in stored] == [
        ("b-invoice", "cfo", "john"), ("b-launch", "cfo", "john"), ("b-launch", "cmo", "john")]
    assert all(c["legacy_result"]["classification"] == "legacy" for c in stored)
    assert [c["agent_result"]["classification"] for c in stored] == [
        "agent-cfo", "agent-cfo", "agent-cmo"]
    rows = _profile_rows(box)
    assert rows["cfo"] == NOTHING and rows["cmo"] == NOTHING  # agent results never acted on
    assert all(ch.done(p) for p in paths)


def test_shadow_turn_failure_never_touches_legacy(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="shadow", agent="shadow", fail={"cmo"})
    path = ch.write("b-launch", source_id)
    ch.run(path)
    assert ch.done(path) and ch.rows("escalations") == ["legacy verdict"]
    stored = _comparisons(box)
    assert [(c["profile"], bool(c["agent_result"]), bool(c["agent_error"])) for c in stored] == [
        ("cfo", True, False), ("cmo", False, True)]


def test_agent_no_pick_is_stored_only(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="shadow", agent="agent")
    path = ch.write("b-chat", source_id)
    ch.run(path)
    assert ch.done(path) and _decisions(box) == {"b-chat": []}
    assert ch.deepseek.calls == [] and turns.calls == []
    assert ch.box_rows() == {"escalations": [], ch.tasks: [], ch.notes: []}


@pytest.mark.parametrize("router", ["off", "registry-down"])
def test_agent_without_a_decision_is_legacy(setup, box, router, monkeypatch):  # noqa: F811
    ch, source_id, model, turns = setup(router="off" if router == "off" else "enforce",
                                        agent="agent")
    if router == "registry-down":
        monkeypatch.setattr(registry, "box_dsn",
                            lambda config=None: "postgresql://nobody@127.0.0.1:1/none")
    path = ch.write("b-launch", source_id)
    ch.run(path)
    assert ch.done(path) and turns.calls == [] and len(ch.deepseek.calls) == 1
    assert ch.rows("escalations") == ["legacy verdict"]
    assert model.calls == []


def test_agent_unsourced_batch_is_legacy(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="enforce", agent="agent")
    path = ch.write("b-launch", None)
    ch.run(path)
    assert ch.done(path) and turns.calls == [] and model.calls == []
    assert ch.rows("escalations") == ["legacy verdict"]


def _arrival_entries(monkeypatch, user):
    _session_as(monkeypatch, user)
    body = _client(user).get("/api/needs-you").json()
    return [i for i in body["items"] if i["context"].get("arrival_key")]


def _verdict_once(ch, profile="cfo"):
    return {"escalations": [f"{profile} verdict"], ch.tasks: ["pay INV-77"],
            ch.notes: ["INV-77 overdue"]}


def test_agent_one_profile(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="enforce", agent="agent")
    path = ch.write("b-invoice", source_id)
    ch.run(path)
    assert ch.done(path) and len(model.calls) == 1
    assert turns.calls == [("cfo", "john", f"triage_{ch.kind}_b-invoice_cfo")]
    assert ch.deepseek.calls == []
    assert ch.box_rows() == _verdict_once(ch)
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77")]
    assert {owner for owner, _ in rows["cfo"]["notifications"]} == {"john"}
    assert rows["cmo"] == NOTHING and rows["default"] == NOTHING
    assert _comparisons(box) == []


def test_agent_two_profiles(setup, box, monkeypatch):  # noqa: F811
    ch, source_id, model, turns = setup(router="shadow", agent="agent")
    path = ch.write("b-launch", source_id)
    ch.run(path)
    assert ch.done(path) and len(model.calls) == 1
    assert turns.profiles() == ["cfo", "cmo"] and ch.deepseek.calls == []
    assert ch.box_rows() == _verdict_once(ch)  # box-wide SQLite written once
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77")] == rows["cmo"]["todos"]
    assert rows["default"] == NOTHING
    for profile in ("cfo", "cmo"):
        assert {owner for owner, _ in rows[profile]["notifications"]} == {"john"}  # nothing for Mary
    assert ch.sent == [JOHN_CHAT]  # one push per arrival per person, never the box chat

    [entry] = _arrival_entries(monkeypatch, "john")  # one Needs You entry
    assert entry["context"]["profiles"] == ["cfo", "cmo"]
    assert _arrival_entries(monkeypatch, "mary") == []


def test_agent_retry_runs_only_the_failed_profile(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="enforce", agent="agent", fail={"cmo"})
    path = ch.write("b-launch", source_id)
    ch.run(path)
    assert not ch.done(path)
    batch = json.loads(path.read_text())
    assert batch["_profiles_done"] == ["cfo"] and batch["_agent_attempts"] == 1
    turns.fail.clear()
    ch.run(path)
    assert ch.done(path) and turns.profiles() == ["cfo", "cmo", "cmo"]
    assert len(model.calls) == 1  # the retry reused the stored decision
    assert ch.box_rows() == _verdict_once(ch)
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77")] == rows["cmo"]["todos"]
    assert ch.deepseek.calls == []


def test_agent_falls_back_to_legacy_after_three_failed_passes(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="enforce", agent="agent", fail={"cmo"})
    path = ch.write("b-launch", source_id)
    for attempt in (1, 2):
        ch.run(path)
        assert not ch.done(path)
        assert json.loads(path.read_text())["_agent_attempts"] == attempt
    assert ch.deepseek.calls == []
    ch.run(path)
    assert ch.done(path)
    assert turns.profiles() == ["cfo", "cmo", "cmo", "cmo"]
    assert len(ch.deepseek.calls) == 1 and len(model.calls) == 1
    # CFO's result already wrote the box-wide rows; legacy does not repeat them.
    assert ch.box_rows() == _verdict_once(ch)
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77")]
    assert rows["cmo"]["todos"] == [("john", "Legacy to-do")]  # as John@CMO
    assert {owner for owner, _ in rows["cmo"]["notifications"]} == {"john"}
    assert rows["default"] == NOTHING  # nothing for the install owner
    assert "_agent_attempts" in json.loads(Path(ch.processed, path.name).read_text())


def test_agent_all_failed_falls_back_to_legacy_box_rows(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="enforce", agent="agent", fail={"cfo", "cmo"})
    path = ch.write("b-launch", source_id)
    for _ in range(3):
        ch.run(path)
    assert ch.done(path) and len(ch.deepseek.calls) == 1 and len(model.calls) == 1
    assert ch.box_rows() == {"escalations": ["legacy verdict"], ch.tasks: ["legacy task"],
                             ch.notes: ["legacy note"]}  # once, not per profile
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Legacy to-do")] == rows["cmo"]["todos"]
    assert rows["default"] == NOTHING


def test_agent_shortcuts_never_route_or_run_a_turn(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="enforce", agent="agent")
    if ch.kind == "email":
        path = ch.write("b-news", source_id, sender="newsletter@shop.example",
                        text="Deals! Click to unsubscribe")
    else:
        path = ch.write("b-media", source_id, text="")
    ch.run(path)
    assert ch.done(path)
    assert model.calls == [] and turns.calls == [] and ch.deepseek.calls == []


def _routing_rows(box, profile):  # noqa: F811
    """(title, routing source, routing batch) of every to-do, and the context of
    every notification, in ``profile``."""
    async def read():
        conn = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            schema = app_schema("prod", profile=profile)
            todos = [tuple(r) for r in await conn.fetch(
                f"SELECT title, routing_source_id, routing_batch_id FROM {schema}.tasks "
                "ORDER BY created_at")]
            contexts = [json.loads(r[0]) if r[0] else None for r in await conn.fetch(
                f"SELECT context FROM {schema}.notifications ORDER BY created_at")]
            return todos, contexts
        finally:
            await conn.close()

    return asyncio.run(read())


def _todo_dicts(box, profile, user):  # noqa: F811
    """``Todo.as_dict()`` (the API's row shape) of ``user``'s to-dos in ``profile``."""
    async def read():
        with _scoped_to(box["homes"][profile]):
            app = get_store("supabase-app", "prod", config=pg_config(box["dsn"]))
            principal = await PrincipalStore(app).get(user)
            items, _cursor = await TodoStore(app).list(principal)
        return [t.as_dict() for t in items]

    return asyncio.run(read())


def test_agent_todo_and_alert_carry_the_routing_link(setup, box, monkeypatch):  # noqa: F811
    ch, source_id, model, turns = setup(router="enforce", agent="agent")
    path = ch.write("b-launch", source_id)
    ch.run(path)
    assert ch.done(path)
    link = {"routing_source_id": source_id, "routing_batch_id": "b-launch"}
    for profile in ("cfo", "cmo"):
        todos, contexts = _routing_rows(box, profile)
        assert todos == [("Pay INV-77", source_id, "b-launch")]
        # The to-do's announcement and the escalation alert both carry it.
        assert contexts == [link, link]

    [entry] = _arrival_entries(monkeypatch, "john")
    assert {k: entry["context"][k] for k in link} == link
    # The to-do record carries it, and the owner can ask the router why.
    todo = _todo_dicts(box, "cfo", "john")[0]
    assert (todo["routing_source_id"], todo["routing_batch_id"]) == (source_id, "b-launch")
    [decision] = _client("john").get(
        "/api/sources/decisions",
        params={"source_id": todo["routing_source_id"], "batch_id": todo["routing_batch_id"]},
    ).json()["decisions"]
    assert decision["selected"] == ["cfo", "cmo"]
    assert decision["message_count"] == 1
    # WhatsApp numbers are masked in the Sources API (#989).
    assert decision["first_sender"] in ("supplier@example.com", "Supplier <+85••••••22>")
    # Owner-only: Mary cannot read John's decision behind the to-do.
    _session_as(monkeypatch, "mary")
    assert _client("mary").get(
        "/api/sources/decisions", params={"source_id": source_id, "batch_id": "b-launch"},
    ).json() == {"decisions": []}


def test_legacy_todo_has_no_routing_link(setup, box):  # noqa: F811
    ch, source_id, model, turns = setup(router="shadow", agent="legacy")
    path = ch.write("b-invoice", source_id)
    ch.run(path)
    assert ch.done(path)
    todos, contexts = _routing_rows(box, "default")
    assert todos and all(t[1:] == (None, None) for t in todos)
    assert all(c is None for c in contexts)
