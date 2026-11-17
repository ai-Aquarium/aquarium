"""A started to-do follows its project: archived or failed closes it,
unarchived or started again brings it back (Leo, 2026-11-17).

Real routes and SQLite stores on a temp HERMES_HOME, the owner-scoped to-do
store stand-in from ``test_todo_start_task``.
"""

from __future__ import annotations

import dataclasses

import pytest

from hermes_cli import profile_refs, projects_db, projects_run
from tests.hermes_cli.test_todo_start_task import (  # noqa: F401 - fixture
    OWNER,
    TODO_ID,
    _start,
    env,
)


@pytest.fixture
def started(env, tmp_path, monkeypatch):  # noqa: F811
    client, state = env
    project = _start(client).json()["project"]
    monkeypatch.setattr(
        profile_refs, "_profile_homes", lambda: [("default", tmp_path / "home")]
    )

    async def _here(identity):
        return OWNER if identity == OWNER.user_id else None

    monkeypatch.setattr(profile_refs, "_principal_here", _here)
    return client, state, project


def _stage(state):
    return state["store"].rows[TODO_ID].stage


def _open_runs(conn, project_id):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM project_runs WHERE project_id = ? "
        "AND status IN ('running', 'waiting', 'blocked')", (project_id,)
    )]


def _close_open_runs(project_id):
    with projects_db.connect_closing() as conn:
        for run in _open_runs(conn, project_id):
            projects_db.close_project_run(conn, run["id"], status="cancelled")


def test_archiving_the_task_dismisses_its_todo_and_restoring_brings_it_back(started):
    client, state, project = started
    _close_open_runs(project["id"])
    resp = client.post(f"/api/registry/projects/{project['slug']}/archive", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["todo"]["stage"] == "dismissed"
    assert state["store"].rows[TODO_ID].outcome == f"Project {project['slug']} archived"

    resp = client.post(f"/api/registry/projects/{project['slug']}/restore", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["todo"]["stage"] == "working"
    assert _stage(state) == "working"


def test_restoring_never_reopens_a_todo_the_person_closed(started):
    client, state, project = started
    _close_open_runs(project["id"])
    client.post(f"/api/registry/projects/{project['slug']}/archive", json={})
    state["store"].rows[TODO_ID] = dataclasses.replace(
        state["store"].rows[TODO_ID], stage="done", status="completed", outcome="Sent by hand"
    )
    resp = client.post(f"/api/registry/projects/{project['slug']}/restore", json={})
    assert resp.status_code == 200, resp.text
    assert "todo" not in resp.json()
    assert _stage(state) == "done"


def test_a_failed_run_closes_the_todo_and_a_retry_brings_it_back(started):
    client, state, project = started
    with projects_db.connect_closing() as conn:
        [run] = _open_runs(conn, project["id"])
        projects_run.close_run(conn, run=run, status="failed", error="boom")
    assert _stage(state) == "dismissed"
    assert state["store"].rows[TODO_ID].outcome == f"Project {project['slug']} failed"
    # Closing again is a no-op: applied once.
    transitions = len(state["store"].transitions)
    with projects_db.connect_closing() as conn:
        failed = projects_db.get_project_run_by_id(conn, run["id"])
    from hermes_cli import todo_task

    assert failed is not None
    todo_task.on_run_closed(failed)
    assert len(state["store"].transitions) == transitions

    resp = client.post(f"/api/registry/projects/{project['slug']}/quick-task/start", json={})
    assert resp.status_code == 200, resp.text
    assert _stage(state) == "working"


def test_a_cancelled_run_leaves_the_todo_alone(started):
    _client, state, project = started
    with projects_db.connect_closing() as conn:
        [run] = _open_runs(conn, project["id"])
        projects_run.close_run(conn, run=run, status="cancelled")
    assert _stage(state) == "working"
