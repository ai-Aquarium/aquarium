"""Existing to-dos move into the two-perspective model; started to-dos
resolve to their project (``/todos/<id>``, list rows, ``D`` refs).

Real paths on a temp HERMES_HOME (projects/kanban SQLite, the real routers,
short refs): ``hermes todos migrate-to-projects`` turns working / review
to-dos into one-off Manual projects with their draft and reply carried into
the brief, leaves staged / open ones as suggestions and done / dismissed ones
closed, is idempotent, and ``--revert`` removes only untouched migration
projects. The Postgres to-do store is the owner-scoped stand-in from
``test_todo_start_task``.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import (
    profile_refs,
    projects_api,
    projects_db,
    refs_api,
    short_refs,
    todo_migration,
    todos_api,
    todos_cmd,
)
from hermes_cli.access import Principal
from hermes_cli.todo_store import STAGE_STATUS
from hermes_cli.todo_work import DRAFT_FILENAME, REPLY_FILENAME, draft_dir_for
from tests.hermes_cli.test_todo_start_task import (  # noqa: F401 - fixture
    OWNER,
    TODO_ID,
    FakeTodoStore,
    _projects,
    _start,
    env,
)

WORKING = "8d0c4c62-0d4e-4c55-9d1c-6a43a3b0f002"
REVIEW = "8d0c4c62-0d4e-4c55-9d1c-6a43a3b0f003"
DONE = "8d0c4c62-0d4e-4c55-9d1c-6a43a3b0f004"
STAGED = "8d0c4c62-0d4e-4c55-9d1c-6a43a3b0f005"


async def _list(self, principal, *, stages=None, include_snoozed=False, limit=50,
                cursor=None, **_):
    rows = [t for t in self.rows.values()
            if (principal.is_owner or t.owner_user_id == principal.user_id)
            and (not stages or t.stage in stages)]
    start = int(cursor or 0)
    page = rows[start:start + limit]
    more = start + limit < len(rows)
    return page, (str(start + limit) if more else None)


async def _facets(self, principal, **_):
    counts: dict[str, int] = {}
    for t in self.rows.values():
        counts[t.stage] = counts.get(t.stage, 0) + 1
    return {"stages": [{"value": k, "count": v} for k, v in counts.items()],
            "priorities": [], "sources": []}


async def _history(self, principal, todo_id, **_):
    return []


async def _get(self, principal, todo_id, **_):
    todo = self.rows.get(todo_id)
    if todo is None or not (principal.is_owner or todo.owner_user_id == principal.user_id):
        return None
    return todo


@pytest.fixture
def world(env, tmp_path, monkeypatch):  # noqa: F811
    client, state = env
    monkeypatch.setattr(FakeTodoStore, "list", _list, raising=False)
    monkeypatch.setattr(FakeTodoStore, "facets", _facets, raising=False)
    monkeypatch.setattr(FakeTodoStore, "history", _history, raising=False)
    monkeypatch.setattr(FakeTodoStore, "get", _get)
    store: FakeTodoStore = state["store"]
    store.add(id=WORKING, stage="working", status=STAGE_STATUS["working"],
              title="Price the Q4 tender", owner_user_id="ada",
              work_result={"draft_text": "Tender price: HKD 1.2m", "reply_text": ""})
    store.add(id=REVIEW, stage="review", status=STAGE_STATUS["review"],
              title="Send Ada a quote for 40 chairs")
    folder = draft_dir_for(REVIEW)
    folder.mkdir(parents=True)
    (folder / DRAFT_FILENAME).write_text("40 oak chairs: HKD 32,000")
    (folder / REPLY_FILENAME).write_text("Dear Ada, the quote is attached.")
    store.add(id=DONE, stage="done", status="completed", title="Old")
    store.add(id=STAGED, stage="staged", status="pending", title="Maybe")
    return client, state


def _migrate(capsys, *, dry_run=False, revert=False) -> dict:
    args = argparse.Namespace(todos_command="migrate-to-projects", actor=None,
                              dry_run=dry_run, revert=revert, json=True)
    assert todos_cmd.todos_command(args) == 0
    return json.loads(capsys.readouterr().out)


@pytest.fixture
def cli(world, monkeypatch):
    _client, state = world

    async def _resolve(actor):
        return state["store"], OWNER

    monkeypatch.setattr(todos_cmd, "_resolve", _resolve)
    return world


def _project_of(todo_id):
    with projects_db.connect_closing() as conn:
        return projects_db.project_for_todo(conn, profile="default", todo_id=todo_id)


def test_working_and_review_todos_become_manual_projects_with_their_drafts(cli, capsys):
    client, state = cli
    before = dict(state["store"].rows)
    report = _migrate(capsys)
    assert sorted(m["todo_id"] for m in report["moved"]) == [WORKING, REVIEW]
    assert report["suggestions"] == 2  # TODO_ID (open) + STAGED
    assert report["closed"] == 1
    assert report["failed"] == []

    review = _project_of(REVIEW)
    working = _project_of(WORKING)
    assert review is not None and working is not None
    for project in (review, working):
        assert project.cadence == "one_off"
        assert project.autonomy == "manual"
        assert project.status == "planning"  # nobody pressed Start yet
    assert "40 oak chairs: HKD 32,000" in review.description
    assert "Dear Ada, the quote is attached." in review.description
    assert "could you send me a quote for 40 oak chairs" in review.description
    assert str(draft_dir_for(REVIEW)) in review.description
    assert "Tender price: HKD 1.2m" in working.description
    with projects_db.connect_closing() as conn:
        assert not projects_db.list_project_runs(conn, review.id)
        members = projects_db.get_project_members(conn, working.id)
        assert [(m["user_id"], m["role"]) for m in members] == [("ada", "lead")]
        links = projects_db.get_project_links(conn, review.id)
        started_from = projects_db.project_todo(conn, review.id)
    assert {(link["kind"], link["added_by"]) for link in links} == {
        ("todo", todo_migration.MIGRATION_ACTOR), ("arrival", todo_migration.MIGRATION_ACTOR),
    }
    assert started_from is not None
    assert started_from["reply_route"]["account_id"] == "acme"
    # The to-dos themselves are untouched: stage, history and draft files.
    assert state["store"].rows == before
    assert state["store"].transitions == []
    assert (draft_dir_for(REVIEW) / DRAFT_FILENAME).is_file()


def test_the_migration_is_idempotent_and_a_dry_run_writes_nothing(cli, capsys):
    dry = _migrate(capsys, dry_run=True)
    assert len(dry["moved"]) == 2 and _projects() == []
    _migrate(capsys)
    again = _migrate(capsys)
    assert again["moved"] == []
    assert sorted(a["todo_id"] for a in again["already"]) == [WORKING, REVIEW]
    assert len(_projects()) == 2


def test_revert_removes_only_untouched_migration_projects(cli, capsys):
    client, state = cli
    started = _start(client).json()["project"]  # a person's own Start task
    _migrate(capsys)
    review = _project_of(REVIEW)
    assert review is not None
    with projects_db.connect_closing() as conn:
        projects_db.set_project_status(conn, review.id, "active")
    resp = client.post(f"/api/registry/projects/{review.slug}/cards", json={"title": "Price it"})
    assert resp.status_code == 200, resp.text

    report = _migrate(capsys, revert=True)
    assert [r["todo_id"] for r in report["removed"]] == [WORKING]
    assert [k["todo_id"] for k in report["kept"]] == [REVIEW]
    assert _project_of(WORKING) is None
    assert _project_of(REVIEW) is not None
    started_now = _project_of(TODO_ID)
    assert started_now is not None and started_now.id == started["id"]
    # Re-running brings the removed one back, and only that one.
    assert [m["todo_id"] for m in _migrate(capsys)["moved"]] == [WORKING]


def test_a_started_todo_carries_its_project_on_detail_and_list(world):
    client, _state = world
    detail = client.get(f"/api/registry/todos/{TODO_ID}").json()
    assert detail["project"] is None
    project = _start(client).json()["project"]
    detail = client.get(f"/api/registry/todos/{TODO_ID}").json()
    fresh = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["project"] == {
        "id": project["id"], "slug": project["slug"], "ref": project["ref"],
        "name": fresh["name"], "status": fresh["status"],
        "url": f"/projects/{project['slug']}",
    }
    items = {i["id"]: i for i in client.get("/api/registry/todos").json()["items"]}
    assert items[TODO_ID]["project"]["slug"] == project["slug"]
    assert items[STAGED]["project"] is None


def test_a_project_the_caller_cannot_read_is_not_named(cli, capsys):
    client, state = cli
    _migrate(capsys)  # WORKING's project is Ada's (lead), not Leo's
    state["actor"] = Principal(user_id="eve", display="Eve", role="member")
    state["store"].add(id=WORKING, stage="working", status="in_progress",
                       title="Price the Q4 tender", owner_user_id="eve")
    detail = client.get(f"/api/registry/todos/{WORKING}").json()
    assert detail["project"] is None


@pytest.fixture
def refs(world, tmp_path, monkeypatch):
    client, state = world
    home = tmp_path / "home"
    monkeypatch.setattr(profile_refs, "_profile_homes", lambda: [("default", home)])
    monkeypatch.setattr(
        "hermes_cli.todo_store.default_store", lambda mode=None: state["store"]
    )

    async def _read(request):
        return state["actor"]

    monkeypatch.setattr(projects_api, "_principal_read", _read)
    app = FastAPI()
    app.include_router(refs_api.router)
    app.include_router(todos_api.router)
    app.include_router(projects_api.router)
    ref = short_refs.assign_quietly("D", TODO_ID, profile="default")
    return TestClient(app), state, ref


def test_a_d_ref_opens_the_todo_until_it_is_started_then_its_project(refs):
    client, state, ref = refs
    before = client.get(f"/api/refs/{ref}").json()
    assert (before["kind"], before["url"]) == ("todo", f"/todos/{TODO_ID}")

    project = _start(client).json()["project"]
    after = client.get(f"/api/refs/{ref}").json()
    assert after["ref"] == ref
    assert after["kind"] == "project"
    assert after["id"] == project["id"]
    assert after["url"] == f"/projects/{project['slug']}"
    assert after["project_slug"] == project["slug"]
    assert after["todo"]["id"] == TODO_ID
    assert after["profile"] == "default"


def test_a_d_ref_whose_project_the_caller_cannot_read_stays_the_todo(refs):
    client, state, ref = refs
    _start(client)
    with projects_db.connect_closing() as conn:
        project = projects_db.project_for_todo(conn, profile="default", todo_id=TODO_ID)
        assert project is not None
        conn.execute("DELETE FROM project_members WHERE project_id = ?", (project.id,))
        conn.execute("UPDATE projects SET owner_user_id = 'ada' WHERE id = ?", (project.id,))
        conn.commit()
    # Leo as an ordinary member (the instance owner may read every project).
    state["actor"] = Principal(user_id="leo", display="Leo", role="member")
    body: dict[str, Any] = client.get(f"/api/refs/{ref}").json()
    assert body["kind"] == "todo"
    assert body["url"] == f"/todos/{TODO_ID}"
