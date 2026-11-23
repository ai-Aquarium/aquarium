"""The project Log (Stage 6): ``GET /{slug}/log``.

Behaviour contracts: rows come newest first and pages chain through
``next_cursor`` without gaps or repeats; ``actor`` splits people from
agents and ``kind`` narrows by what changed; runs, playbook activations,
re-plans, approvals and tool calls are derived from records the project
already keeps; edits nothing else records land in ``project_activity``;
only tool *names* leave a session store; and the route is the project's
own read gate (non-members get the same 404 as a missing project).
"""

from __future__ import annotations

import json
import sqlite3
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db, projects_api, projects_db, projects_log
from hermes_cli.access import Principal

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
MEMBER = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
STRANGER = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]

_PREFIX = "/api/registry/projects"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    state = {"actor": OWNER, "enrolled": set(), "subject": "leo"}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set(state["enrolled"])

    async def _subject(request):
        return state["subject"]

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)
    # One state.db per profile under tmp_path, in place of real profile homes.
    stores = tmp_path / "profiles"
    monkeypatch.setattr(
        projects_log, "_state_db",
        lambda profile: (
            stores / profile / "state.db"
            if (stores / profile / "state.db").exists() else None
        ),
    )
    app = FastAPI()
    app.include_router(projects_api.router)
    return TestClient(app), state, stores


def _create(env, body=None) -> dict:
    client, state, _ = env
    payload = {
        "goal": "Ship the Monday digest — to every subscriber",
        "description": "A weekly digest compiled and emailed each Monday.",
        "host_profile": "default",
        "outputs": [{"title": "The Monday digest email"}],
    }
    payload.update(body or {})
    prev, state["actor"] = state["actor"], OWNER
    try:
        resp = client.post(f"{_PREFIX}/", json=payload)
    finally:
        state["actor"] = prev
    assert resp.status_code == 200, resp.text
    return resp.json()


def _log(env, slug, **params) -> dict:
    client = env[0]
    resp = client.get(f"{_PREFIX}/{slug}/log", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _all(env, slug, **params) -> list[dict]:
    rows, cursor = [], None
    while True:
        page = _log(env, slug, **params, **({"cursor": cursor} if cursor else {}))
        rows += page["entries"]
        cursor = page["next_cursor"]
        if not cursor:
            return rows


def _state_db(stores, profile: str) -> sqlite3.Connection:
    path = stores / profile / "state.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY "
        "AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, "
        "tool_calls TEXT, tool_name TEXT, timestamp REAL);"
        "CREATE TABLE IF NOT EXISTS api_call_log (id INTEGER PRIMARY KEY "
        "AUTOINCREMENT, session_id TEXT, kanban_task_id TEXT, ts REAL);"
    )
    return conn


def _tool_message(conn, session_id, names, at, secret="sk-secret-arg"):
    calls = [
        {"id": f"c{i}", "type": "function",
         "function": {"name": n, "arguments": json.dumps({"token": secret})}}
        for i, n in enumerate(names)
    ]
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls, "
        "timestamp) VALUES (?, 'assistant', '', ?, ?)",
        (session_id, json.dumps(calls), at),
    )
    conn.commit()


def test_people_and_agents_from_existing_records(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    now = int(time.time())
    with projects_db.connect_closing() as conn:
        manual = projects_db.open_project_run(
            conn, project_id=pid, trigger="manual", triggered_by="leo",
            profile="default",
        )
        projects_db.update_project_run(
            conn, manual["id"], status="done", ended_at=now,
            score_user=4, scored_by="leo", scored_at=now,
        )
        projects_db.open_project_run(
            conn, project_id=pid, trigger="schedule", profile="default",
        )
        rev = projects_db.save_playbook_rev(
            conn, project_id=pid, steps=[{"key": "draft", "title": "Draft"}], created_by="leo",
        )
        projects_db.activate_playbook_rev(
            conn, pid, rev, note="activated automatically: re-plan"
        )
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(bconn, title="Draft digest", project_id=pid)
        kanban_db.append_event(bconn, tid, "replan_proposed", {"rev": rev})
        kanban_db.append_event(bconn, tid, "commented", {"by": "leo"})

    rows = _all(env, slug)
    by_action = {}
    for r in rows:
        by_action.setdefault(r["action"], []).append(r)
    starts = {r["detail"]["trigger"]: r for r in by_action["run_started"]}
    assert starts["manual"]["actor"] == "person"
    assert starts["manual"]["who"] == "leo"
    assert starts["schedule"]["actor"] == "agent"
    assert by_action["run_finished"][0]["actor"] == "agent"
    assert by_action["run_scored"][0]["who"] == "leo"
    assert by_action["playbook_activated"][0]["actor"] == "agent"
    replan = by_action["replan_proposed"][0]
    assert replan["actor"] == "agent"
    assert replan["link"] == {"type": "card", "id": tid}
    assert "commented" not in by_action  # card chatter is not project log
    for r in by_action["run_started"]:
        assert r["link"]["type"] == "run"
    # Newest first, every time.
    keys = [(r["at"], r["id"]) for r in rows]
    assert keys == sorted(keys, reverse=True)
    assert len({r["id"] for r in rows}) == len(rows)


def test_actor_and_kind_filters_partition_the_log(env):
    project = _create(env)
    slug = project["slug"]
    with projects_db.connect_closing() as conn:
        projects_db.open_project_run(
            conn, project_id=project["id"], trigger="schedule",
            profile="default",
        )
    everything = _all(env, slug)
    people = _all(env, slug, actor="people")
    agents = _all(env, slug, actor="agents")
    assert {r["actor"] for r in people} <= {"person"}
    assert {r["actor"] for r in agents} <= {"agent"}
    assert {r["id"] for r in people} | {r["id"] for r in agents} == {
        r["id"] for r in everything
    }
    for kind in projects_log.KINDS:
        narrowed = _all(env, slug, kind=kind)
        assert {r["kind"] for r in narrowed} <= {kind}
        assert {r["id"] for r in narrowed} == {
            r["id"] for r in everything if r["kind"] == kind
        }


def test_pages_chain_without_gaps_or_repeats(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    with projects_db.connect_closing() as conn:
        for _ in range(7):
            run = projects_db.open_project_run(
                conn, project_id=pid, trigger="manual", triggered_by="leo",
                profile="default",
            )
            projects_db.update_project_run(
                conn, run["id"], status="done", ended_at=run["started_at"]
            )
    whole = _log(env, slug, limit=200)["entries"]
    paged = _all(env, slug, limit=3)
    assert [r["id"] for r in paged] == [r["id"] for r in whole]
    first = _log(env, slug, limit=3)
    assert len(first["entries"]) == 3 and first["next_cursor"]


def test_bad_filters_and_cursor_are_400(env):
    slug = _create(env)["slug"]
    client = env[0]
    for params in ({"actor": "robots"}, {"kind": "chat"}, {"cursor": "nope"},
                   {"limit": "x"}):
        assert client.get(f"{_PREFIX}/{slug}/log", params=params).status_code == 400


def test_edits_with_no_other_record_land_in_project_activity(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    client = env[0]
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=pid, user_id="ada", role="member", added_by="leo"
        )
    assert client.patch(
        f"{_PREFIX}/{slug}", json={"description": "Now fortnightly."}
    ).status_code == 200
    assert client.delete(f"{_PREFIX}/{slug}/members/ada").status_code == 200
    assert client.patch(
        f"{_PREFIX}/{slug}/autonomy", json={"autonomy": "autonomous"}
    ).status_code == 200

    people = _all(env, slug, actor="people")
    rows = {r["action"]: r for r in people}
    assert rows["brief_edited"]["who"] == "leo"
    assert rows["brief_edited"]["kind"] == "inputs"
    assert rows["brief_edited"]["detail"]["fields"] == ["description"]
    assert rows["member_removed"]["detail"] == {"user_id": "ada"}
    assert rows["autonomy_changed"]["detail"] == {"autonomy": "autonomous"}
    # The brief's text itself is never copied into the log.
    assert "fortnightly" not in json.dumps(rows["brief_edited"])


def test_tool_calls_are_names_only_and_linked_to_the_run(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    stores = env[2]
    with projects_db.connect_closing() as conn:
        run = projects_db.open_project_run(
            conn, project_id=pid, trigger="manual", triggered_by="leo",
            profile="default",
        )
        projects_db.update_project_run(conn, run["id"], session_id="sess-run")
    now = run["started_at"] + 0.1  # inside the run, never in the future
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title="Export CRM", project_id=pid, assignee="default"
        )
    with projects_db.connect_closing() as conn:
        projects_db.link_run_card(conn, run["id"], tid)
    db = _state_db(stores, "default")
    _tool_message(db, "sess-run", ["web_search"], now)
    db.execute(
        "INSERT INTO api_call_log (session_id, kanban_task_id, ts) "
        "VALUES ('sess-card', ?, ?)", (tid, now),
    )
    _tool_message(db, "sess-card", ["read_file", "terminal"], now + 0.5)
    _tool_message(db, "sess-other", ["not_this_project"], now)
    db.close()

    tools = _all(env, slug, kind="tools")
    names = sorted(r["detail"]["tool"] for r in tools)
    assert names == ["read_file", "terminal", "web_search"]
    for r in tools:
        assert r["actor"] == "agent" and r["detail"]["run_no"] == run["run_no"]
    card_rows = [r for r in tools if r["detail"]["tool"] != "web_search"]
    assert all(r["link"] == {"type": "card", "id": tid} for r in card_rows)
    assert "sk-secret-arg" not in json.dumps(tools)
    assert _all(env, slug, kind="tools", actor="people") == []
    # Paging over tool rows still chains.
    assert [r["id"] for r in _all(env, slug, kind="tools", limit=1)] == [
        r["id"] for r in tools
    ]


def test_tool_calls_only_from_project_profiles(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    stores = env[2]
    with projects_db.connect_closing() as conn:
        run = projects_db.open_project_run(
            conn, project_id=pid, trigger="manual", triggered_by="leo",
            profile="default",
        )
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title="Elsewhere", project_id=pid, assignee="intruder"
        )
    with projects_db.connect_closing() as conn:
        projects_db.link_run_card(conn, run["id"], tid)
    db = _state_db(stores, "intruder")
    db.execute(
        "INSERT INTO api_call_log (session_id, kanban_task_id, ts) "
        "VALUES ('s', ?, ?)", (tid, time.time()),
    )
    _tool_message(db, "s", ["terminal"], time.time())
    db.close()
    assert _all(env, slug, kind="tools") == []


def test_private_card_events_hidden_from_other_members(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=pid, user_id="ada", role="lead"
        )
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title="Mallory's card", project_id=pid,
            owner_user_id="mallory", visibility="private:mallory",
        )
        kanban_db.append_event(bconn, tid, "replan_failed", {})
    assert any(r["action"] == "replan_failed" for r in _all(env, slug))
    env[1]["actor"] = MEMBER
    assert not any(r["action"] == "replan_failed" for r in _all(env, slug))


def test_log_read_gate_is_the_project_read_gate(env):
    client, state, _ = env
    private = _create(env, {"visibility": "private"})
    shared = _create(env, {"visibility": "shared"})
    state["actor"] = STRANGER
    assert client.get(f"{_PREFIX}/{private['slug']}/log").status_code == 404
    assert client.get(f"{_PREFIX}/no-such-project/log").status_code == 404
    state["enrolled"] = {"default"}
    assert client.get(f"{_PREFIX}/{private['slug']}/log").status_code == 404
    assert client.get(f"{_PREFIX}/{shared['slug']}/log").status_code == 200
    state["enrolled"] = {"elsewhere"}
    assert client.get(f"{_PREFIX}/{shared['slug']}/log").status_code == 404
    state["enrolled"] = set()
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=private["id"], user_id="eve", role="viewer"
        )
    assert client.get(f"{_PREFIX}/{private['slug']}/log").status_code == 200


def _run_with_session(pid: str, started_at: int) -> dict:
    with projects_db.connect_closing() as conn:
        run = projects_db.open_project_run(
            conn, project_id=pid, trigger="manual", triggered_by="leo",
            profile="default",
        )
        projects_db.update_project_run(conn, run["id"], session_id="sess-run")
        conn.execute(
            "UPDATE project_runs SET started_at = ? WHERE id = ?",
            (started_at, run["id"]),
        )
        conn.commit()
    return run


def test_show_older_reaches_every_tool_call(env):
    project = _create(env)
    base = int(time.time()) - 500
    _run_with_session(project["id"], base)
    db = _state_db(env[2], "default")
    for i in range(1, 102):  # one call a second
        _tool_message(db, "sess-run", [f"t{i}"], base + i)
    db.close()
    rows = _all(env, project["slug"], kind="tools", limit=50)
    assert sorted(r["detail"]["tool"] for r in rows) == sorted(
        f"t{i}" for i in range(1, 102)
    )


def test_paging_inside_one_busy_second(env):
    project = _create(env)
    base = int(time.time()) - 100
    _run_with_session(project["id"], base)
    db = _state_db(env[2], "default")
    for i in range(7):  # all in the same second
        _tool_message(db, "sess-run", [f"same{i}"], base + 10.25)
    _tool_message(db, "sess-run", ["earlier"], base + 5)
    db.close()
    paged = _all(env, project["slug"], kind="tools", limit=2)
    assert sorted(r["detail"]["tool"] for r in paged) == sorted(
        [f"same{i}" for i in range(7)] + ["earlier"]
    )
    assert len({r["id"] for r in paged}) == len(paged)


def test_reassigned_card_keeps_its_earlier_tool_calls(env):
    project = _create(env)
    pid = project["id"]
    base = int(time.time()) - 100
    run = _run_with_session(pid, base)
    with kanban_db.connect_closing() as bconn:
        # Worked by the host profile, then reassigned elsewhere.
        tid = kanban_db.create_task(
            bconn, title="Research", project_id=pid, assignee="writer"
        )
    with projects_db.connect_closing() as conn:
        projects_db.link_run_card(conn, run["id"], tid)
    db = _state_db(env[2], "default")
    db.execute(
        "INSERT INTO api_call_log (session_id, kanban_task_id, ts) "
        "VALUES ('sess-research', ?, ?)", (tid, base + 1),
    )
    _tool_message(db, "sess-research", ["web_search"], base + 2)
    db.close()
    tools = _all(env, project["slug"], kind="tools")
    assert [r["detail"]["tool"] for r in tools] == ["web_search"]
    assert tools[0]["link"] == {"type": "card", "id": tid}


def test_retro_and_delivery_by_a_person_are_credited_to_them(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    client = env[0]
    with projects_db.connect_closing() as conn:
        run = projects_db.open_project_run(
            conn, project_id=pid, trigger="schedule", profile="default",
        )
        oid = projects_db.get_project_outputs(conn, pid)[0]["id"]
    resp = client.post(
        f"{_PREFIX}/{slug}/runs/{run['run_no']}/retro",
        json={"retro": "Went fine."},
    )
    assert resp.status_code == 200, resp.text
    resp = client.post(
        f"{_PREFIX}/{slug}/outputs/{oid}/deliver",
        json={"label": "digest.pdf", "profile": "default", "run_id": run["id"]},
    )
    assert resp.status_code == 200, resp.text

    rows = _all(env, slug)
    retros = [r for r in rows if r["action"] == "run_retro"]
    delivered = [r for r in rows if r["action"] == "output_delivered"]
    assert [(r["actor"], r["who"]) for r in retros] == [("person", "leo")]
    assert [(r["actor"], r["who"]) for r in delivered] == [("person", "leo")]
    assert delivered[0]["detail"]["title"] == "The Monday digest email"
    assert delivered[0]["link"] == {"type": "run", "run_no": run["run_no"]}
    assert "Went fine" not in json.dumps(retros)
    people = {r["id"] for r in _all(env, slug, actor="people")}
    assert {retros[0]["id"], delivered[0]["id"]} <= people


def test_activity_inside_an_open_write_commits_with_it(env):
    project = _create(env)
    with projects_db.connect_closing() as conn:
        with projects_db.write_txn(conn):
            projects_db.record_project_activity(
                conn, project["id"], "tools_edited", actor="leo",
                detail={"fields": ["toolsets"]},
            )
    assert any(
        r["action"] == "tools_edited" for r in _all(env, project["slug"])
    )


def test_retro_and_delivery_by_an_agent_stay_with_the_agent(env):
    project = _create(env)
    pid, slug = project["id"], project["slug"]
    client, state, _ = env
    with projects_db.connect_closing() as conn:
        run = projects_db.open_project_run(
            conn, project_id=pid, trigger="schedule", profile="default",
        )
        oid = projects_db.get_project_outputs(conn, pid)[0]["id"]
    state["subject"] = ""  # a session-less caller: an agent through the CLI
    assert client.post(
        f"{_PREFIX}/{slug}/runs/{run['run_no']}/retro", json={"retro": "ok"}
    ).status_code == 200
    assert client.post(
        f"{_PREFIX}/{slug}/outputs/{oid}/deliver",
        json={"label": "draft.md", "profile": "writer", "run_id": run["id"]},
    ).status_code == 200
    agents = {r["action"]: r for r in _all(env, slug, actor="agents")}
    assert agents["run_retro"]["who"] == "default"
    assert agents["output_delivered"]["who"] == "writer"
    assert not any(
        r["action"] in ("run_retro", "output_delivered")
        for r in _all(env, slug, actor="people")
    )
