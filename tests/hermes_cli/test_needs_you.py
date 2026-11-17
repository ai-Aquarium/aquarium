"""``GET /api/needs-you`` — everything waiting on the caller, in one list.

Contracts: every row has a stable ``<source>:<id>`` id and a deep link; a
caller only sees waits that are theirs to act on; a wait already carried by
a notification row is never listed twice; blocking sorts first, oldest
first; and a wait is pushed at most once.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from hermes_cli import kanban_db, needs_you as ny, projects_db
from hermes_cli.access import Principal
from tests.hermes_cli.test_projects_api import (  # noqa: F401 — fixture
    MEMBER_P,
    OWNER,
    STRANGER,
    _activate,
    _create,
    _member,
    env,
)


def _notif(id, *, target="leo", dedupe_key=None, kind="approval", reversible=False,
           title="t", body="b", created=1000.0):
    return SimpleNamespace(
        id=id, kind=kind, owner_user_id=target, visibility="shared", title=title,
        body=body, reversible=reversible, status="pending", dedupe_key=dedupe_key,
        created_at=datetime.fromtimestamp(created, tz=timezone.utc),
    )


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


def test_notifications_map_to_sources_with_deep_links():
    rows = ny.notification_entries([
        _notif("n1", dedupe_key="proj:digest:run:3:checkpoint:step-2"),
        _notif("n2", dedupe_key="proj:digest:run:3:budget"),
        _notif("n3", dedupe_key="proj:digest:run:4:waiting_on_you:t_abc"),
        _notif("n4", dedupe_key="todo-action:td1"),
        _notif("n5", dedupe_key=None, kind="proactive_ask"),
        _notif("n6", target="ada"),
    ], "leo")
    by_id = {r["id"]: r for r in rows}
    assert set(by_id) == {"notif:n1", "notif:n2", "notif:n3", "notif:n4", "notif:n5"}
    assert by_id["notif:n1"]["source"] == "project_checkpoint"
    assert by_id["notif:n1"]["href"] == "/projects/digest/runs/3"
    assert by_id["notif:n1"]["severity"] == "blocking"
    assert by_id["notif:n2"]["source"] == "budget"
    assert by_id["notif:n3"]["source"] == "card_wait"
    assert by_id["notif:n3"]["href"] == "/projects/digest/cards/t_abc"
    assert by_id["notif:n3"]["context"] == {
        "project_slug": "digest", "run_no": 4, "task_id": "t_abc",
    }
    assert by_id["notif:n4"]["source"] == "todo"
    assert by_id["notif:n4"]["severity"] == "approval"
    assert by_id["notif:n5"]["source"] == "notification"
    assert by_id["notif:n5"]["severity"] == "fyi"
    assert all(r["notification_id"] == r["id"][len("notif:"):] for r in rows)
    # Irreversible → only an "open" action.
    assert all(r["reversible"] is False for r in rows)
    assert all([a["id"] for a in r["actions"]] == ["open"] for r in rows)
    assert by_id["notif:n1"]["created_at"] == 1000.0


def test_reversible_notification_offers_one_tap_answers():
    [row] = ny.notification_entries([_notif("n1", reversible=True)], "leo")
    assert row["reversible"] is True
    approve = next(a for a in row["actions"] if a["id"] == "approve")
    assert approve["endpoint"] == "/api/comms/notifications/n1/answer"
    assert approve["body"] == {"answer": "approved"}


def test_parse_project_key_rejects_foreign_keys():
    assert ny.parse_project_key("app-cpu:x") is None
    assert ny.parse_project_key("proj:x:run:nope:checkpoint") is None
    assert ny.parse_project_key("proj:x:run:2:waiting_on_you:a:b") == {
        "slug": "x", "run_no": 2, "kind": "waiting_on_you", "suffix": "a:b",
    }


# ---------------------------------------------------------------------------
# Project-derived waits
# ---------------------------------------------------------------------------


def _waiting_project(env):
    project = _create(env)
    _activate(env, project)
    pid = project["id"]
    with projects_db.connect_closing() as conn:
        projects_db.open_project_run(conn, project_id=pid, trigger="manual", profile="default")
        conn.execute("UPDATE project_runs SET status = 'waiting' WHERE project_id = ?", (pid,))
        conn.execute(
            "UPDATE project_outputs SET status = 'delivered', delivered_at = 1700000100 "
            "WHERE project_id = ?", (pid,),
        )
        conn.execute(
            "INSERT INTO project_clarify_rounds (project_id, round_no, status, created_by, created_at) "
            "VALUES (?, 1, 'open', 'agent', 1700000050)", (pid,),
        )
        for i in range(2):
            conn.execute(
                "INSERT INTO project_clarifications (id, project_id, round_no, position, question, status, created_at) "
                "VALUES (?, ?, 1, ?, 'Who reads it?', 'open', 1700000060)", (f"q{i}", pid, i),
            )
        conn.commit()
    with kanban_db.connect_closing() as bconn:
        blocked = kanban_db.create_task(bconn, title="Needs creds", project_id=pid)
        private = kanban_db.create_task(
            bconn, title="Mallory's card", project_id=pid,
            owner_user_id="mallory", visibility="private:mallory", triage=True,
        )
        gated = kanban_db.create_task(bconn, title="Send email", project_id=pid)
        bconn.execute(
            "UPDATE tasks SET status = 'blocked', created_at = 1700000010 WHERE id IN (?, ?)",
            (blocked, private),
        )
        bconn.execute(
            "INSERT INTO task_approvals (task_id, approval_key, label, status, requested_at) "
            "VALUES (?, 'send', 'Send to 400 people', 'pending', 1700000020)", (gated,),
        )
        bconn.commit()
    return project, blocked, private, gated


def _ids(rows):
    return sorted(r["id"] for r in rows)


def test_project_waits_are_listed_once_with_deep_links(env):
    project, blocked, private, gated = _waiting_project(env)
    slug = project["slug"]
    rows = ny.project_entries(OWNER, set(), set())
    by_source = {}
    for r in rows:
        by_source.setdefault(r["source"], []).append(r)
    assert [r["id"] for r in by_source["project_checkpoint"]] == [f"project_run:{slug}:1"]
    assert by_source["project_checkpoint"][0]["href"] == f"/projects/{slug}/runs/1"
    assert _ids(by_source["card_blocked"]) == sorted([f"card_blocked:{blocked}", f"card_blocked:{private}"])
    [approval] = by_source["card_approval"]
    assert approval["id"] == f"card_approval:{gated}:send"
    assert approval["href"] == f"/projects/{slug}/cards/{gated}"
    assert approval["severity"] == "approval"
    [output] = by_source["output_acceptance"]
    assert output["created_at"] == 1700000100 and output["href"] == f"/projects/{slug}"
    [clarify] = by_source["clarify"]
    assert clarify["id"] == f"clarify:{slug}:1" and "2 questions" in clarify["title"]
    # It ran, so its plan is not "awaiting approval".
    assert "plan_approval" not in by_source
    assert all(r["href"] and r["reversible"] is False for r in rows)


def test_project_waits_follow_roles_and_card_visibility(env):
    project, blocked, private, _gated = _waiting_project(env)
    # Not a member → nothing, even though the project might be readable.
    assert ny.project_entries(STRANGER, set(), set()) == []
    _member(project["id"], "ada", "lead")
    ids = _ids(ny.project_entries(MEMBER_P, set(), set()))
    assert f"card_blocked:{blocked}" in ids
    assert f"card_blocked:{private}" not in ids


def test_notified_waits_are_not_duplicated(env):
    project, blocked, _private, _gated = _waiting_project(env)
    slug = project["slug"]
    notifs = ny.notification_entries([
        _notif("n1", dedupe_key=f"proj:{slug}:run:1:waiting_on_you:{blocked}"),
    ], "leo")
    covered = ny.notification_dedupe_keys(notifs)
    assert covered == {(slug, "run", 1), (slug, "card", blocked)}
    ids = _ids(ny.project_entries(OWNER, set(), covered))
    assert f"project_run:{slug}:1" not in ids
    assert f"card_blocked:{blocked}" not in ids


def test_drafted_plan_on_unrun_project_awaits_approval(env):
    project = _create(env)
    with projects_db.connect_closing() as conn:
        conn.execute("DELETE FROM project_playbook WHERE project_id = ?", (project["id"],))
        conn.execute(
            "INSERT INTO project_playbook (project_id, rev, active, created_at) "
            "VALUES (?, 1, 0, 1700000000)", (project["id"],),
        )
        conn.commit()
    rows = [r for r in ny.project_entries(OWNER, set(), set()) if r["source"] == "plan_approval"]
    assert [r["id"] for r in rows] == [f"plan:{project['slug']}:1"]


# ---------------------------------------------------------------------------
# In-memory approvals
# ---------------------------------------------------------------------------


@pytest.fixture
def gateway_queue():
    from tools import approval

    added: list[str] = []

    def _add(session_key, *, user, command="rm -rf /tmp/x", description="delete files"):
        entry = approval._ApprovalEntry(
            {"command": command, "description": description}, None, user,
        )
        with approval._lock:
            approval._gateway_queues.setdefault(session_key, []).append(entry)
        added.append(session_key)
        return entry

    yield _add
    with approval._lock:
        for key in added:
            approval._gateway_queues.pop(key, None)


def test_gateway_approvals_are_listable(gateway_queue):
    from tools.approval import list_pending_gateway_approvals

    first = gateway_queue("run_a", user="ada")
    second = gateway_queue("run_b", user="leo")
    listed = list_pending_gateway_approvals(["run_a", "run_b"])
    assert [a["approval_id"] for a in listed] == [first.approval_id, second.approval_id]
    assert listed[0]["requester_user_id"] == "ada"
    assert list_pending_gateway_approvals(["run_b"])[0]["session_key"] == "run_b"
    assert first.approval_id != second.approval_id


def test_chat_approvals_are_the_requesters(gateway_queue):
    from tools.approval import list_pending_gateway_approvals

    gateway_queue("run_a", user="ada")
    gateway_queue("run_c", user=None)
    gateway_queue("run_tg", user="ada")  # not an agent-home run
    runs = {"run_a": {"session_id": "s1", "profile": "ops"},
            "run_c": {"session_id": "s2", "profile": None}}
    approvals = list_pending_gateway_approvals(["run_a", "run_c", "run_tg"])
    ada = ny.chat_approval_entries(approvals, runs, MEMBER_P, admin=False)
    assert [r["context"]["run_id"] for r in ada] == ["run_a"]
    [row] = ada
    assert row["id"].startswith("chat_approval:run_a:")
    assert row["href"] == "/chat?session=s1&profile=ops"
    assert row["severity"] == "blocking" and row["reversible"] is False
    once = next(a for a in row["actions"] if a["id"] == "once")
    assert once["endpoint"] == "/api/chat/approval"
    assert once["body"] == {"runId": "run_a", "choice": "once"}
    leo = ny.chat_approval_entries(approvals, runs, OWNER, admin=True)
    assert [r["context"]["run_id"] for r in leo] == ["run_c"]
    assert ny.chat_approval_entries(approvals, runs, STRANGER, admin=False) == []


def test_webview_pending_actions():
    session = SimpleNamespace(pending={
        "w1": SimpleNamespace(id="w1", reason="submit form", created_at=5.0, resolved=None,
                              action=SimpleNamespace(kind="submit", url="https://x.test")),
        "w2": SimpleNamespace(id="w2", reason="done", created_at=6.0, resolved=True,
                              action=SimpleNamespace(kind="click", url="")),
    })
    [row] = ny.webview_entries(session)
    assert row["id"] == "webview:w1" and row["href"] == "/webview"
    grant = next(a for a in row["actions"] if a["id"] == "grant")
    assert grant["endpoint"] == "/api/webview/approval/w1" and grant["body"] == {"grant": True}
    assert ny.webview_entries(None) == []


def test_profile_suggestions():
    s = SimpleNamespace(id="ps1", proposed_name="Researcher", proposed_role="r",
                        rationale="You keep asking for papers", origin_profile="default",
                        created_at=datetime.fromtimestamp(42, tz=timezone.utc))
    [row] = ny.profile_suggestion_entries([s])
    assert row["id"] == "profile_suggestion:ps1"
    assert row["severity"] == "fyi" and row["href"] == "/profiles" and row["created_at"] == 42


# ---------------------------------------------------------------------------
# Ordering + response
# ---------------------------------------------------------------------------


def _row(id, source, created):
    return ny.entry(id=id, source=source, title=id, href="/x", created_at=created)


def test_finalize_sorts_by_severity_then_oldest_and_dedupes():
    rows = ny.finalize([
        _row("t", "todo", 1), _row("c2", "card_wait", 20), _row("o", "output_acceptance", 5),
        _row("a", "card_approval", 3), _row("c1", "budget", 10), _row("c2", "card_wait", 99),
    ])
    assert [r["id"] for r in rows] == ["c1", "c2", "a", "o", "t"]
    resp = ny.response(rows)
    assert resp["count"] == 5
    assert resp["by_severity"] == {"blocking": 2, "approval": 1, "review": 1, "fyi": 1}
    assert resp["items"] == rows
    count = ny.response(rows, count_only=True)
    assert count["items"] == [] and count["count"] == 5
    assert set(resp) == {"items", "count", "by_severity", "suggested_count", "collected_at"}


# ---------------------------------------------------------------------------
# Push ledger
# ---------------------------------------------------------------------------


def test_push_claims_each_new_wait_once(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    old = _row("old", "card_wait", 1)
    # First look seeds silently: no replay of existing waits.
    assert ny.claim_new_for_push("leo", [old]) == []
    new = _row("new", "card_approval", 2)
    fyi = _row("fyi", "todo", 3)
    chat = _row("chat_approval:r:1", "chat_tool_approval", 4)
    assert [i["id"] for i in ny.claim_new_for_push("leo", [old, new, fyi, chat])] == ["new"]
    assert ny.claim_new_for_push("leo", [old, new, fyi, chat]) == []
    # Users have separate ledgers.
    assert ny.claim_new_for_push("ada", [new]) == []


def test_push_ledger_forgets_long_gone_waits(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    ny.claim_new_for_push("leo", [])
    path = ny._ledger_path("leo")
    path.write_text(json.dumps({"gone": time.time() - 8 * 24 * 3600}))
    item = _row("gone", "card_wait", 1)
    assert [i["id"] for i in ny.claim_new_for_push("leo", [item])] == ["gone"]


@pytest.mark.asyncio
async def test_push_new_tags_with_the_item_id(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from plugins.platforms.app import push

    sent = []

    async def _send(tag, title, body, url=""):
        sent.append((tag, title, url))
        return 1

    monkeypatch.setattr(push, "send_push", _send)
    await ny.push_new("leo", [])
    assert await ny.push_new("leo", [_row("card_approval:t:k", "card_approval", 1)]) == 1
    assert sent == [("card_approval:t:k", "card_approval:t:k", "/x")]
    assert await ny.push_new("leo", [_row("card_approval:t:k", "card_approval", 1)]) == 0


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@pytest.fixture
def route(tmp_path, monkeypatch, gateway_queue):
    from starlette.testclient import TestClient

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from hermes_cli import web_server
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    state = {"actor": SimpleNamespace(user_id="leo", role="owner", is_owner=True,
                                      private_visibility="private:leo")}

    async def _principal(request, *, allow_as=False):
        return state["actor"]

    pushed = []

    async def _push(user_id, items):
        pushed.append((user_id, [i["id"] for i in items]))
        return 0

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _principal)
    monkeypatch.setattr(ny, "project_entries", lambda *a, **k: [])
    monkeypatch.setattr(ny, "push_new", _push)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    web_server._CHAT_RUNS.update({
        "nyr1": {"session_id": "s-ada", "done": False, "profile": None, "started_at": 50.0},
        "nyr2": {"session_id": "s-eve", "done": True, "profile": None, "started_at": 60.0},
    })
    gateway_queue("nyr1", user="ada")
    gateway_queue("nyr2", user="eve")
    yield c, state, pushed
    for k in ("nyr1", "nyr2"):
        web_server._CHAT_RUNS.pop(k, None)


def test_route_lists_the_callers_waits(route):
    client, state, pushed = route
    state["actor"] = SimpleNamespace(user_id="ada", role="member", is_owner=False,
                                     private_visibility="private:ada")
    body = client.get("/api/needs-you").json()
    assert set(body) == {"items", "count", "by_severity", "suggested_count", "collected_at"}
    assert [i["source"] for i in body["items"]] == ["chat_tool_approval"]
    assert body["items"][0]["href"] == "/chat?session=s-ada"
    assert body["count"] == 1 and body["by_severity"]["blocking"] == 1
    # Members' waits are not pushed to the instance's devices.
    assert pushed == []

    count = client.get("/api/needs-you?include=count").json()
    assert count["items"] == [] and count["count"] == 1

    state["actor"] = SimpleNamespace(user_id="leo", role="owner", is_owner=True,
                                     private_visibility="private:leo")
    body = client.get("/api/needs-you").json()
    assert body["count"] == 0
    assert pushed == [("leo", [])]


def test_route_requires_the_session_token(route):
    from starlette.testclient import TestClient
    from hermes_cli.web_server import app

    assert TestClient(app).get("/api/needs-you").status_code == 401


def test_route_is_empty_without_the_multi_user_datastore(route, monkeypatch):
    from hermes_cli import web_server

    client, _state, _pushed = route

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("multi user datastore not configured")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    body = client.get("/api/needs-you").json()
    assert body["items"] == [] and body["count"] == 0


def test_data_drafts_are_listed_only_for_sources_the_caller_approves():
    rows = [
        {"id": "s1", "name": "HSDOS WMS", "access": "manage", "draft_version": 4,
         "draft_changes": 3, "draft_origins": ["chat", "feedback"],
         "draft_proposed_at": "2026-11-14T12:00:00+00:00"},
        {"id": "s2", "name": "Shared", "access": "propose", "draft_version": 2, "draft_changes": 1},
        {"id": "s3", "name": "Clean", "access": "manage", "draft_version": None},
    ]
    [item] = ny.data_draft_entries(rows)
    assert item["id"] == "data_draft:s1:4"
    assert item["severity"] == "review"
    assert item["href"] == "/data/s1/review"
    assert item["title"] == "Dictionary draft v4 for HSDOS WMS is ready"
    assert item["detail"] == "3 changes · from a chat · from answer feedback"
    assert item["actions"][0]["label"] == "Review"
    # agent-home translates these parts; the English text above is the fallback.
    assert item["i18n"]["title"] == [
        {"key": "titles.dataDraft", "vars": {"v": 4, "source": "HSDOS WMS"}}
    ]
    assert [p["key"] for p in item["i18n"]["detail"]] == [
        "details.changes", "details.origin.chat", "details.origin.feedback",
    ]
    # list_sources sends the draft time as ISO text; the card must keep its age.
    assert item["created_at"] == datetime(2026, 11, 14, 12, tzinfo=timezone.utc).timestamp()


def test_schema_drift_cards_are_listed_only_for_managers_with_drift():
    rows = [
        {"id": "s1", "name": "HSDOS WMS", "access": "manage",
         "schema_checked_at": "2026-11-15T09:00:00+00:00",
         "schema_drift": [
             {"table": "orders", "change": "columns"},
             {"table": "customers", "change": "added"},
             {"table": "legacy", "change": "removed"},
         ]},
        {"id": "s2", "name": "Shared", "access": "propose",
         "schema_drift": [{"table": "t", "change": "added"}]},
        {"id": "s3", "name": "Clean", "access": "manage", "schema_drift": []},
    ]
    [item] = ny.data_schema_entries(rows)
    assert item["id"] == "data_schema:s1"
    assert item["severity"] == "review"
    assert item["href"] == "/data/s1"
    assert item["title"] == "The HSDOS WMS schema changed — its dictionary needs an update"
    # the card names at most two drifted tables in detail text
    assert item["detail"] == "3 tables differ · orders: columns changed · customers is new"
    assert item["i18n"]["title"] == [
        {"key": "titles.dataSchema", "vars": {"source": "HSDOS WMS"}}
    ]
    assert [p["key"] for p in item["i18n"]["detail"]] == [
        "details.schemaDrift", "details.schemaItem.columns", "details.schemaItem.added",
    ]
    assert item["created_at"] == datetime(2026, 11, 15, 9, tzinfo=timezone.utc).timestamp()


def test_failed_health_checks_raise_a_blocking_card_for_the_owner():
    failed = {"status": "failed", "error": "could not connect: timeout",
              "checked_at": "2026-11-15T09:00:00+00:00"}
    rows = [
        {"id": "c1", "name": "ERP", "access": "manage", "health": failed},
        {"id": "c2", "name": "Shared", "access": "read", "health": failed},
        {"id": "c3", "name": "Fine", "access": "manage", "health": {"status": "ok"}},
        {"id": "s1", "name": "Site", "access": "manage", "health": None},
    ]
    [item] = ny.data_health_entries(rows)
    assert item["id"] == "data_health:c1"
    assert item["severity"] == "blocking"
    assert item["href"] == "/data/c1"
    assert item["detail"] == "could not connect: timeout"
    assert item["i18n"]["title"] == [{"key": "titles.dataHealth", "vars": {"source": "ERP"}}]


# ---------------------------------------------------------------------------
# One arrival raised in several profiles (FG-03 P5)
# ---------------------------------------------------------------------------


def test_arrival_keys_round_trip_and_survive_separators():
    key = ny.arrival_key("email", "john@example.com", "<a:b|c@x>")
    assert key.startswith("arrival:email:") and key.count(":") == 3
    tagged = ny.with_arrival("todo:t1", key)
    assert ny.split_arrival(tagged) == ("todo:t1", key)
    assert ny.split_arrival("todo:t1") == ("todo:t1", None)
    assert ny.with_arrival("todo:t1", None) == "todo:t1"


def test_rows_for_one_arrival_merge_into_one_entry_listing_profiles():
    key = ny.arrival_key("email", "john@example.com", "<m1@x>")
    cfo = ny.tag_profile(ny.notification_entries([
        _notif("n1", target="john", kind="proactive_ask", created=2000.0,
               dedupe_key=ny.with_arrival("todo:t1", key)),
        _notif("n2", target="john", kind="proactive_ask", created=3000.0,
               dedupe_key=ny.with_arrival(ny.TRIAGE_ALERT, key)),
    ], "john"), "cfo")
    cmo = ny.tag_profile(ny.notification_entries([
        _notif("n3", target="john", kind="proactive_ask", created=1000.0,
               dedupe_key=ny.with_arrival("todo:t9", key)),
    ], "john"), "cmo", link=True)
    other = ny.notification_entries([_notif("n4", target="john", dedupe_key="todo:t5")], "john")
    assert other[0]["context"]["todo_id"] == "t5"
    assert cmo[0]["href"] == "/todos?profile=cmo"

    items = ny.finalize(cfo + cmo + other)
    assert [i["id"] for i in items] == [key, "notif:n4"]  # review sorts before fyi
    merged = items[0]
    assert merged["context"]["profiles"] == ["cfo", "cmo"]
    assert "profile" not in merged["context"]
    assert merged["severity"] == "review"  # the alert outranks the fyi to-dos
    assert merged["created_at"] == 1000.0


def test_an_arrival_from_one_profile_keeps_its_profile_and_arrival_id():
    key = ny.arrival_key("whatsapp", "phone2", "m1")
    rows = ny.tag_profile(ny.notification_entries([
        _notif("n1", target="john", kind="proactive_ask", dedupe_key=ny.with_arrival("todo:t1", key)),
    ], "john"), "cfo")
    [item] = ny.finalize(rows)
    assert item["id"] == key and item["context"]["profile"] == "cfo"
    assert item["context"]["profiles"] == ["cfo"]


def test_an_arrival_is_pushed_once_per_person_across_profiles(tmp_path, monkeypatch):
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: tmp_path)
    key = ny.arrival_key("email", "a", "1")
    assert ny.claim_arrival_push("john", key) is True
    assert ny.claim_arrival_push("john", key) is False
    assert ny.claim_arrival_push("mary", key) is True
    ny.release_arrival_push("john", key)
    assert ny.claim_arrival_push("john", key) is True


class _SuggestedStore:
    """``TodoStore``'s suggested-task reads: ids starting with ``s`` are suggested."""

    def __init__(self, count=0):
        self.count, self.asked, self.closed = count, None, 0

    async def _connect(self):
        store = self

        class _Conn:
            async def close(self):
                store.closed += 1

        return _Conn()

    async def count_suggested(self, principal, *, connection=None):
        return self.count

    async def suggested_among(self, principal, ids, *, connection=None):
        self.asked = list(ids)
        return [i for i in ids if i.startswith("s")]


@pytest.mark.asyncio
async def test_suggested_tasks_marks_every_suggested_alert_however_many():
    """A suggested task and its alert count once past any page or probe limit."""
    notifs = [_notif(f"n{i}", dedupe_key=f"todo:s{i}", kind="fyi") for i in range(250)]
    notifs.append(_notif("started", dedupe_key="todo:w1", kind="fyi"))
    notifs.append(_notif("reply", dedupe_key="todo-action:s1", kind="approval"))
    items = ny.notification_entries(notifs, "leo")
    store = _SuggestedStore(count=260)
    assert await ny.suggested_tasks(items, object(), store=store) == 260
    marked = [i for i in items if i["context"].get("suggested")]
    assert len(marked) == 250
    assert len(store.asked) == 251
    assert store.closed == 1
    assert not any(i["context"].get("suggested") for i in items if i["severity"] == "approval")
    assert not [i for i in items if i["context"].get("todo_id") == "w1"][0]["context"].get("suggested")


@pytest.mark.asyncio
async def test_suggested_tasks_counts_without_todo_alerts():
    items = ny.notification_entries([_notif("a", dedupe_key="triage:x", kind="fyi")], "leo")
    store = _SuggestedStore(count=3)
    assert await ny.suggested_tasks(items, object(), store=store) == 3
    assert store.asked is None


def test_response_carries_the_suggested_count():
    assert ny.response([], suggested_count=4)["suggested_count"] == 4
    assert ny.response([], count_only=True)["suggested_count"] is None
