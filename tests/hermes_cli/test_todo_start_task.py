"""Start task: a system to-do becomes the user's one-off project.

Real paths on a temp HERMES_HOME: the to-do route
``POST /api/registry/todos/{id}/start-task`` creates the project through
Projects Task mode (real SQLite projects + kanban stores, plan drafted and
run 1 started inline), the project's PATCH to ``done`` closes the to-do,
and a card's ``hermes projects propose-send`` reply defaults to the source
message's route and is sent through the real email egress (only
``smtplib.SMTP`` is faked). The to-do store is Postgres in production; here
it is an in-memory stand-in with the same ``get`` / ``set_stage`` /
``record_outbound`` contract, scoped to the owner.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import threading
import types
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import (
    profile_refs,
    projects_api,
    projects_board_api,
    projects_db,
    projects_run,
    todo_task,
    todos_api,
)
from hermes_cli.access import Principal
from hermes_cli.projects_cli import _cmd_propose_send
from hermes_cli.todo_store import STAGE_STATUS, Todo

OWNER = Principal(user_id="leo", display="Leo", role="owner")
OTHER = Principal(user_id="eve", display="Eve", role="member")
TODO_ID = "8d0c4c62-0d4e-4c55-9d1c-6a43a3b0f001"
ARRIVAL_ID = "0b6f6a8e-8f57-4d0c-9a77-0c1f6e8b2a10"
ARRIVAL = {
    "id": ARRIVAL_ID,
    "surface": "email",
    "account_id": "acme",
    "external_id": "<msg-1@client.example>",
    "sender_id": "ada@client.example",
    "sender_name": "Ada",
    "subject": "Quote for 40 chairs",
    "body": "Hi, could you send me a quote for 40 oak chairs by Friday?",
}
PLAN = {"body": "Price it, reply.", "steps": [
    {"key": "price", "title": "Price the chairs"},
    {"key": "reply", "title": "Draft the reply", "depends_on": ["price"]},
]}


class FakeTodoStore:
    """The ``TodoStore`` contract this feature uses, owner-scoped."""

    def __init__(self) -> None:
        self.rows: dict[str, Todo] = {}
        self.outbound: list[dict] = []
        self.transitions: list[tuple[str, str, str]] = []
        self._store = object()

    def add(self, **fields) -> Todo:
        base: dict[str, Any] = dict(
            id=TODO_ID, owner_user_id=OWNER.user_id, visibility="private",
            title="Send Ada a quote for 40 chairs", description="Oak, by Friday.",
            stage="open", status="pending", priority="high", origin="triage",
            current_state="captured", trigger_state="captured",
            completion_state="done", source_kind="inbound", source_ref=ARRIVAL_ID,
        )
        base.update(fields)
        todo = Todo(**base)
        self.rows[todo.id] = todo
        return todo

    async def get(self, principal, todo_id, **_):
        todo = self.rows.get(todo_id)
        if todo is None or todo.owner_user_id != principal.user_id:
            return None
        return todo

    async def set_stage(self, principal, todo_id, stage, *, actor=None, outcome=None, **_):
        todo = await self.get(principal, todo_id)
        assert todo is not None
        todo = dataclasses.replace(
            todo, stage=stage, status=STAGE_STATUS[stage],
            outcome=outcome if outcome is not None else todo.outcome,
        )
        self.rows[todo_id] = todo
        self.transitions.append((todo_id, stage, str(actor)))
        return todo

    async def record_outbound(self, principal, todo_id, *, event, channel, actor, **_):
        assert await self.get(principal, todo_id) is not None
        self.outbound.append({"todo_id": todo_id, "event": event, "channel": channel})


class _Registry:
    async def get(self, principal, item_id):
        if item_id != ARRIVAL_ID or principal.user_id != OWNER.user_id:
            return None
        return types.SimpleNamespace(as_dict=lambda: dict(ARRIVAL))


_REAL_THREAD = threading.Thread


class _InlineThread:
    """Runs the Task-mode job inline; any other thread is a real one."""

    def __new__(cls, *args, kwargs=None, **kw):
        if kwargs is None:
            return _REAL_THREAD(*args, **kw)
        return super().__new__(cls)

    def __init__(self, *, target, kwargs, **_):
        self._run = lambda: target(**kwargs)

    def start(self):
        self._run()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    monkeypatch.setattr("hermes_cli.datastore.get_store", lambda *a, **k: object())

    class _Approvals:
        async def initialize(self):
            pass

        async def create(self, **kwargs):
            return object()

    monkeypatch.setattr(
        projects_run, "_approval_store", lambda app_store, *, config: _Approvals()
    )
    monkeypatch.setattr(
        projects_run, "_enabled_toolsets_for_profile", lambda profile: ["web"]
    )
    monkeypatch.setattr(projects_run, "_available_skill_names", lambda profile: [])

    state: dict[str, Any] = {"actor": OWNER, "subject": OWNER.user_id}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set()

    async def _subject(request):
        return state["subject"]

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(
        "hermes_cli.web_server._comms_session_subject",
        lambda request: state["subject"], raising=False,
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)

    projects_api._PLAN_DRAFTS.clear()
    monkeypatch.setattr(
        projects_api, "threading", types.SimpleNamespace(Thread=_InlineThread)
    )
    monkeypatch.setattr(projects_api, "_call_plan_model", lambda prompt: json.dumps(PLAN))
    state["brief_prompts"] = []

    def _brief(prompt):
        state["brief_prompts"].append(prompt)
        return json.dumps({"title": "Quote 40 oak chairs", "goal": "Ada gets a quote.",
                           "output": "The quote"})

    monkeypatch.setattr(projects_api, "_call_brief_model", _brief)

    store = FakeTodoStore()
    store.add()
    state["store"] = store

    async def _ready(_store):
        return True

    async def _source(principal, todo):
        return dict(ARRIVAL) if todo.source_ref == ARRIVAL_ID else None

    monkeypatch.setattr(todos_api, "_store", lambda mode=None: store)
    monkeypatch.setattr(todos_api, "_table_ready", _ready)
    monkeypatch.setattr(todos_api, "_source_item", _source)
    monkeypatch.setattr(todo_task, "_todo_store", lambda: store)
    monkeypatch.setattr(
        "hermes_cli.inbound_registry.default_registry", lambda *a, **k: _Registry()
    )
    monkeypatch.setattr(profile_refs, "current_profile", lambda: "default")

    async def _no_source(channel, account, **_):
        return state.get("source")

    monkeypatch.setattr("hermes_cli.reply_accounts.find_source", _no_source)

    app = FastAPI()
    app.include_router(todos_api.router)
    app.include_router(projects_api.router)
    app.include_router(projects_board_api.router)
    yield TestClient(app), state
    projects_api._PLAN_DRAFTS.clear()


def _start(client, **body):
    return client.post(f"/api/registry/todos/{TODO_ID}/start-task", json=body)


def _projects() -> list:
    with projects_db.connect_closing() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT id, slug, todo_profile, todo_id, reply_route FROM projects"
        )]


def test_start_task_makes_a_manual_one_off_project_seeded_with_the_message(env):
    client, state = env
    resp = _start(client)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["created"] is True
    project = out["project"]
    assert project["cadence"] == "one_off"
    assert project["autonomy"] == "manual"
    assert out["todo"]["stage"] == "working"
    assert state["store"].rows[TODO_ID].outcome == f"Started as project {project['slug']}"

    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["status"] == "active"
    assert "Send Ada a quote for 40 chairs" in detail["description"]
    assert "could you send me a quote for 40 oak chairs" in detail["description"]
    assert "hermes projects propose-send" in detail["description"]
    assert "could you send me a quote" in state["brief_prompts"][0]
    with projects_db.connect_closing() as conn:
        links = {(link["kind"], link["profile"], link["ref"])
                 for link in projects_db.get_project_links(conn, project["id"])}
        started_from = projects_db.project_todo(conn, project["id"])
        assert started_from is not None
        assert started_from["reply_route"] == {
            "channel": "email", "target": "ada@client.example", "account_id": "acme",
            "thread_id": "<msg-1@client.example>", "subject": "Re: Quote for 40 chairs",
            "arrival_id": ARRIVAL_ID,
        }
    assert ("todo", "default", TODO_ID) in links
    assert ("arrival", "default", ARRIVAL_ID) in links
    # Same Task-mode path: plan drafted and run 1 started.
    runs = client.get(f"/api/registry/projects/{project['slug']}/runs").json()["runs"]
    assert [r["run_no"] for r in runs] == [1]


def test_starting_the_same_todo_again_returns_the_same_project(env):
    client, state = env
    first = _start(client).json()
    again = _start(client)
    assert again.status_code == 200, again.text
    assert again.json()["created"] is False
    assert again.json()["project"]["id"] == first["project"]["id"]
    assert len(_projects()) == 1
    runs = client.get(f"/api/registry/projects/{first['project']['slug']}/runs").json()
    assert len(runs["runs"]) == 1
    # Even once the to-do is closed, a re-start finds its project.
    state["store"].rows[TODO_ID] = dataclasses.replace(
        state["store"].rows[TODO_ID], stage="done", status="completed"
    )
    assert _start(client).json()["project"]["id"] == first["project"]["id"]


def test_concurrent_starts_make_one_project(env):
    client, _state = env
    results: list = []
    threads = [_REAL_THREAD(target=lambda: results.append(_start(client))) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert sum(r.json()["created"] for r in results) == 1
    assert len(_projects()) == 1


def test_one_project_per_todo_is_held_by_the_store(env):
    client, _state = env
    pid = _start(client).json()["project"]["id"]
    other = projects_api.create_task_project_sync(OWNER, "Something else", "default", "manual")
    with projects_db.connect_closing() as conn:
        assert not projects_db.set_project_todo(
            conn, other.id, profile="default", todo_id=TODO_ID
        )
        found = projects_db.project_for_todo(conn, profile="default", todo_id=TODO_ID)
        assert found is not None and found.id == pid


def test_starting_is_a_human_act(env):
    client, state = env
    state["subject"] = ""
    resp = _start(client)
    assert resp.status_code == 403
    assert _projects() == []
    assert state["store"].rows[TODO_ID].stage == "open"


def test_a_todo_the_caller_cannot_see_is_404_and_makes_nothing(env):
    client, state = env
    state["actor"] = OTHER
    state["subject"] = OTHER.user_id
    assert _start(client).status_code == 404
    assert _projects() == []


def test_a_closed_todo_without_a_project_is_refused(env):
    client, state = env
    state["store"].add(stage="dismissed", status="cancelled")
    assert _start(client).status_code == 409
    assert _projects() == []


def test_bad_autonomy_is_refused(env):
    client, _state = env
    assert _start(client, autonomy="yolo").status_code == 422
    assert _projects() == []


def test_project_done_closes_its_todo(env):
    client, state = env
    slug = _start(client).json()["project"]["slug"]
    resp = client.patch(f"/api/registry/projects/{slug}", json={"status": "done"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["todo"]["stage"] == "done"
    todo = state["store"].rows[TODO_ID]
    assert todo.stage == "done"
    assert todo.outcome == f"Project {slug} done"


def test_a_project_not_started_from_a_todo_closes_nothing(env):
    client, state = env
    project = projects_api.create_task_project_sync(OWNER, "Unrelated", "default", "manual")
    with projects_db.connect_closing() as conn:
        projects_db.set_project_status(conn, project.id, "active")
    resp = client.patch(f"/api/registry/projects/{project.slug}", json={"status": "done"})
    assert resp.status_code == 200, resp.text
    assert "todo" not in resp.json()
    assert state["store"].rows[TODO_ID].stage == "open"


# -- replies ---------------------------------------------------------------


class _FakeSMTP:
    sent: list = []

    def __init__(self, host, port, timeout=None):
        pass

    def starttls(self, context=None):
        pass

    def login(self, user, password):
        pass

    def send_message(self, msg):
        _FakeSMTP.sent.append(msg)

    def quit(self):
        pass

    def close(self):
        pass


@pytest.fixture
def reply_card(env, tmp_path, monkeypatch):
    client, _state = env
    slug = _start(client).json()["project"]["slug"]
    resp = client.post(f"/api/registry/projects/{slug}/cards", json={"title": "Reply to Ada"})
    assert resp.status_code == 200, resp.text
    task_id = resp.json()["task_id"]
    monkeypatch.setenv("HERMES_KANBAN_TASK", task_id)
    cfg = tmp_path / "email-config.json"
    cfg.write_text(json.dumps({"accounts": [{
        "id": "acme", "address": "sales@acme.example",
        "smtp": {"host": "smtp.acme.example", "port": 587},
        "credentials_env": "ACME_SMTP_PASSWORD",
    }]}))
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(cfg))
    monkeypatch.setenv("ACME_SMTP_PASSWORD", "pw")
    _FakeSMTP.sent = []
    monkeypatch.setattr("smtplib.SMTP", _FakeSMTP)
    return {"slug": slug, "task_id": task_id}


def _propose(capsys, **over) -> dict:
    args = dict(channel="", to="", account="", subject=None, body="Dear Ada, 40 oak "
                "chairs come to HKD 32,000.", body_file=None, attach=None, task=None,
                json=True)
    args.update(over)
    assert _cmd_propose_send(argparse.Namespace(**args)) == 0
    return json.loads(capsys.readouterr().out)


def _approve(client, card, key):
    return client.post(
        f"/api/registry/projects/{card['slug']}/cards/{card['task_id']}/approvals",
        json={"key": key, "decision": "approve"},
    )


def test_a_project_reply_defaults_to_the_source_message_and_sends_from_its_account(
    env, reply_card, capsys
):
    client, state = env
    proposal = _propose(capsys)
    assert proposal["channel"] == "email"
    assert proposal["target"] == "ada@client.example"
    assert proposal["account"] == "acme"
    assert proposal["subject"] == "Re: Quote for 40 chairs"
    assert proposal["thread"] == "<msg-1@client.example>"
    assert proposal["reply_to"] == {
        "profile": "default", "todo_id": TODO_ID, "arrival_id": ARRIVAL_ID,
    }
    assert _FakeSMTP.sent == []

    resp = _approve(client, reply_card, proposal["key"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["outbound"] == {"event": "sent"}
    [msg] = _FakeSMTP.sent
    assert msg["From"] == "sales@acme.example"
    assert msg["To"] == "ada@client.example"
    assert msg["Subject"] == "Re: Quote for 40 chairs"
    # The reply is on the to-do's own history (execute_proposal's replay guard).
    assert state["store"].outbound == [
        {"todo_id": TODO_ID, "event": "sent", "channel": "email"}
    ]


def test_a_reply_from_an_account_someone_else_owns_is_refused(env, reply_card, capsys):
    client, state = env
    from hermes_cli.source_registry import Source

    state["source"] = Source(
        source_id="src_1", channel="email", address="sales@acme.example",
        owner_user_id="eve",
    )
    key = _propose(capsys)["key"]
    resp = _approve(client, reply_card, key)
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "not_source_owner"
    assert _FakeSMTP.sent == []
    assert state["store"].outbound == []


def test_a_message_to_someone_else_is_an_ordinary_card_send(env, reply_card, capsys):
    client, state = env
    proposal = _propose(capsys, to="accounts@acme.example", subject="Chairs PO")
    assert "reply_to" not in proposal
    assert "thread" not in proposal
    resp = _approve(client, reply_card, proposal["key"])
    assert resp.status_code == 200, resp.text
    [msg] = _FakeSMTP.sent
    assert msg["To"] == "accounts@acme.example"
    assert state["store"].outbound == []


def test_task_mode_quick_task_takes_from_todo_as_the_same_start(env):
    client, state = env
    resp = client.post("/api/registry/projects/quick-task", json={"from_todo": {"id": TODO_ID}})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["created"] is True
    assert out["autonomy"] == "manual"
    assert out["cadence"] == "one_off"
    assert out["todo"]["stage"] == "working"
    # The to-do route and Task mode name the same project.
    again = _start(client).json()
    assert again["created"] is False
    assert again["project"]["id"] == out["id"]
    assert len(_projects()) == 1


def test_quick_task_from_a_todo_in_another_profile_is_refused(env):
    client, _state = env
    resp = client.post(
        "/api/registry/projects/quick-task",
        json={"from_todo": {"id": TODO_ID, "profile": "work"}},
    )
    assert resp.status_code == 422
    assert _projects() == []


def test_quick_task_from_todo_is_a_human_act(env):
    client, state = env
    state["subject"] = ""
    resp = client.post("/api/registry/projects/quick-task", json={"from_todo": {"id": TODO_ID}})
    assert resp.status_code == 403
    assert _projects() == []


def test_the_persons_own_wording_leads_the_brief_and_the_message_stays(env):
    client, _state = env
    resp = _start(client, request="Quote Ada 40 oak chairs at the trade price")
    assert resp.status_code == 200, resp.text
    slug = resp.json()["project"]["slug"]
    description = client.get(f"/api/registry/projects/{slug}").json()["description"]
    assert description.startswith("Quote Ada 40 oak chairs at the trade price")
    assert "Oak, by Friday." not in description
    assert "could you send me a quote for 40 oak chairs" in description
    assert "hermes projects propose-send" in description
    bad = client.post(
        "/api/registry/projects/quick-task",
        json={"from_todo": {"id": TODO_ID}, "request": 42},
    )
    assert bad.status_code == 422
