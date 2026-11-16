"""FG-03 P5 E2E: a triage result processed for one chosen user-profile lands
in that profile's schema, for that owner, and nowhere else.

Real profiles (``default``, ``cfo``, ``cmo``, ``hr``) over a tmp hermes root
and one throwaway Postgres (see ``test_source_registry_e2e``); John and Mary
are people in CFO and CMO. The real handlers, registration modules, to-do and
notification stores and the real ``/api/needs-you`` route run; only the
Telegram send and the work-session launcher are captured.
"""

import asyncio
import json
import sqlite3
import sys
from pathlib import Path

import asyncpg
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom"))

import hermes_cli.datastore as datastore  # noqa: E402
from hermes_cli import needs_you as ny  # noqa: E402
from hermes_cli.access import PrincipalStore  # noqa: E402
from hermes_cli.console_scope import _scoped_to  # noqa: E402
from hermes_cli.datastore import app_schema, get_store  # noqa: E402
from hermes_cli.human_comms import NotificationStore  # noqa: E402
from hermes_cli.inbound_registry import InboundRegistry  # noqa: E402
from hermes_cli.todo_store import TodoStore  # noqa: E402
from tests.hermes_cli._pg_fixture import hermes_root, pg_config, postgres_dsn  # noqa: E402,F401
from tests.hermes_cli.test_source_registry_e2e import _client, _session_as, box  # noqa: E402,F401

BOX_CHAT = "111"
JOHN_CHAT = "777"
ARRIVAL = ("email", "john@example.com", "<m1@x>")
RESULT = {
    "classification": "action",
    "summary": "INV-77 is overdue",
    "escalate": True,
    "escalation_reason": "overdue invoice",
    "escalation_priority": "high",
    "todos": [{"title": "Pay INV-77", "priority": "high", "notify": True}],
    "tasks": [{"description": "pay INV-77"}],
    "memory_facts": [{"fact": "Ann bills on the 1st", "category": "vendor"}],
}


def _batch():
    return {
        "_channel": "email", "batch_id": "b1", "account_id": ARRIVAL[1],
        "sender": "ann@example.com", "sender_name": "Ann",
        "emails": [{"id": "e1", "message_id": ARRIVAL[2], "from_addr": "ann@example.com",
                    "from_name": "Ann", "subject": "INV-77",
                    "body_text": "Invoice INV-77 is overdue"}],
    }


@pytest.fixture
def world(box, tmp_path, monkeypatch):  # noqa: F811
    dsn, homes = box["dsn"], box["homes"]
    config = pg_config(dsn)

    async def init(home, extra):
        with _scoped_to(home):
            app = get_store("supabase-app", "prod", config=config)
            await InboundRegistry(app).initialize()
            await TodoStore(app).initialize()
            await NotificationStore(app, config=config).initialize()
            people = PrincipalStore(app)
            for step in extra:
                await step(people)

    link_john = lambda people: people.link_channel("john", "telegram", JOHN_CHAT)  # noqa: E731
    asyncio.run(init(homes["default"], []))
    asyncio.run(init(homes["cfo"], [link_john]))
    asyncio.run(init(homes["cmo"], [link_john, lambda p: p.enroll("mary", display="Mary")]))
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

    db = sqlite3.connect(tmp_path / "email.db")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE email_tasks (id TEXT, account_id TEXT, source_email_id TEXT,
            description TEXT, due_date TEXT, status TEXT, priority TEXT, created_at TEXT);
        CREATE TABLE escalations (id TEXT PRIMARY KEY, source_phone TEXT, source_msg_id TEXT,
            sender_phone TEXT, reason TEXT, summary TEXT, priority TEXT, status TEXT,
            created_at TEXT, channel TEXT, sender_email TEXT, sender_name TEXT, contact_id INTEGER);
        CREATE TABLE contact_handles (contact_id INTEGER, handle_type TEXT, handle_value TEXT);
    """)
    from shared import triage_handlers

    return {"dsn": dsn, "homes": homes, "sent": sent, "db": db, "th": triage_handlers}


def _rows(dsn):
    async def read():
        conn = await asyncpg.connect(dsn, ssl=False)
        try:
            out = {}
            for profile in ("default", "cfo", "cmo"):
                schema = app_schema("prod", profile=profile)
                out[profile] = {
                    "items": [tuple(r) for r in await conn.fetch(
                        f"SELECT owner_user_id, importance FROM {schema}.inbound_items")],
                    "todos": [tuple(r) for r in await conn.fetch(
                        f"SELECT owner_user_id, stage FROM {schema}.tasks")],
                    "notifications": sorted(tuple(r) for r in await conn.fetch(
                        f"SELECT owner_user_id, split_part(dedupe_key, '|', 1) FROM {schema}.notifications")),
                    "keys": [r[0] for r in await conn.fetch(
                        f"SELECT dedupe_key FROM {schema}.notifications")],
                }
            return out
        finally:
            await conn.close()

    return asyncio.run(read())


def _box_rows(db):
    return [db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            for t in ("email_tasks", "escalations")]


EMPTY = {"items": [], "todos": [], "notifications": [], "keys": []}


def test_a_result_for_john_at_cfo_lands_in_cfo_as_johns(world):
    th, homes = world["th"], world["homes"]
    batch = _batch()
    th.process_result(dict(RESULT), batch, world["db"],
                      profile_home=homes["cfo"], owner_user_id="john")

    rows = _rows(world["dsn"])
    cfo = rows["cfo"]
    assert cfo["items"] == [("john", "high")]
    assert cfo["todos"] == [("john", "open")]
    [todo_key, alert_key] = sorted(k for _, k in cfo["notifications"])
    assert todo_key.startswith("todo:") and alert_key == ny.TRIAGE_ALERT
    assert {owner for owner, _ in cfo["notifications"]} == {"john"}
    assert all(k.endswith("|" + ny.arrival_key(*ARRIVAL)) for k in cfo["keys"])
    assert rows["cmo"] == EMPTY and rows["default"] == EMPTY
    # John's own Telegram, once; never the box chat.
    assert world["sent"] == [JOHN_CHAT]
    assert _box_rows(world["db"]) == [1, 1]
    # Facts: John's own untrusted inbox in CFO, not the profile owner's.
    own = homes["cfo"] / "memories" / "users" / "john" / "INBOX_FACTS.md"
    assert "Ann bills on the 1st" in own.read_text()
    assert not (homes["cfo"] / "memories" / "INBOX_FACTS.md").exists()
    assert not (homes["default"] / "memories" / "INBOX_FACTS.md").exists()
    assert not (homes["cfo"] / "memories" / "users" / "mary").exists()
    assert "todos" not in batch  # the caller's batch is not rewritten


def test_two_profiles_raising_one_arrival_show_once_and_push_once(world, monkeypatch):
    th, homes, db = world["th"], world["homes"], world["db"]
    th.process_result(dict(RESULT), _batch(), db,
                      profile_home=homes["cfo"], owner_user_id="john", box_writes=True)
    th.process_result(dict(RESULT), _batch(), db,
                      profile_home=homes["cmo"], owner_user_id="john", box_writes=False)

    rows = _rows(world["dsn"])
    assert rows["cfo"]["todos"] == [("john", "open")] == rows["cmo"]["todos"]
    assert _box_rows(db) == [1, 1]  # box-wide SQLite written once per batch
    assert world["sent"] == [JOHN_CHAT]  # one push per arrival per person

    _session_as(monkeypatch, "john")
    body = _client("john").get("/api/needs-you").json()
    arrivals = [i for i in body["items"] if i["context"].get("arrival_key")]
    assert [i["id"] for i in arrivals] == [ny.arrival_key(*ARRIVAL)]
    assert arrivals[0]["context"]["profiles"] == ["cfo", "cmo"]

    _session_as(monkeypatch, "mary")
    body = _client("mary").get("/api/needs-you").json()
    assert not [i for i in body["items"] if i["context"].get("arrival_key")]


def test_legacy_call_is_unchanged(world):
    th, homes = world["th"], world["homes"]
    batch = _batch()
    th.process_result(dict(RESULT), batch, world["db"])

    rows = _rows(world["dsn"])
    # Never registered in the box profile: the install owner stands in.
    assert rows["default"]["todos"] == [("leo", "open")]
    assert [k for k in rows["default"]["keys"]] == [f"todo:{k.split(':', 1)[1]}"
                                                     for k in rows["default"]["keys"]]
    assert all("|" not in k for k in rows["default"]["keys"])
    assert rows["cfo"] == EMPTY and rows["cmo"] == EMPTY
    assert world["sent"] == [BOX_CHAT]
    assert _box_rows(world["db"]) == [1, 1]
    assert "Ann bills" in (homes["default"] / "memories" / "INBOX_FACTS.md").read_text()
    assert batch["todos"] == RESULT["todos"]  # updated in place, as before


def test_an_owner_who_is_not_active_in_the_profile_gets_nothing(world):
    th, homes = world["th"], world["homes"]
    th.process_result(dict(RESULT), _batch(), world["db"],
                      profile_home=homes["cmo"], owner_user_id="sus", box_writes=False)
    rows = _rows(world["dsn"])
    assert rows == {"default": EMPTY, "cfo": EMPTY, "cmo": EMPTY}
    assert world["sent"] == [] and _box_rows(world["db"]) == [0, 0]
    with pytest.raises(ValueError):
        th.process_result(dict(RESULT), _batch(), world["db"], owner_user_id="john")


def test_auto_start_runs_the_work_in_the_profile(world, tmp_path, monkeypatch):
    th, homes = world["th"], world["homes"]
    config = tmp_path / "email-config.json"
    config.write_text(json.dumps({"triage": {"auto_work": True}}))
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(config))
    launched = []
    from hermes_cli import todo_work

    monkeypatch.setattr(todo_work, "launch_todo_work",
                        lambda store, principal, todo, **kw: launched.append((principal.user_id, kw)))
    result = {"work_request": {"title": "Draft the payment reply", "instructions": "Reply to Ann",
                               "auto_start": True, "priority": "high"}}
    th.process_result(result, _batch(), world["db"],
                      profile_home=homes["cfo"], owner_user_id="john")

    assert launched == [("john", {"actor": "skill:email-triage", "profile_home": str(homes["cfo"])})]
    rows = _rows(world["dsn"])
    assert rows["cfo"]["todos"] == [("john", "working")]
    assert rows["default"]["todos"] == [] and rows["cmo"]["todos"] == []
