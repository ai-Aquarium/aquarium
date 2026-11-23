"""/{slug}/playbook/drafts — co-creating the plan in per-member drafts.

Contracts: every reader (viewers included) sees every draft, but a draft
is only ever written by its owner — the person or their agent acting as
them; a lead may also discard anyone's. Writes are checked like a
revision, a stale ``expected_version`` is a 409, and Save turns the draft
into the owner's own *inactive* proposal, so two members' drafts become
two proposals side by side and activation stays a human act.
"""

from __future__ import annotations

from hermes_cli import projects_chat_api, projects_db
from hermes_cli.access import Principal

from tests.hermes_cli.test_projects_api import (  # noqa: F401
    MEMBER_P,
    OWNER,
    _create,
    _member,
    env,
)

VIEWER = Principal(user_id="tom", display="Tom", role="member")  # type: ignore[arg-type]

STEPS = [
    {"key": "compile", "title": "Compile the items"},
    {"key": "send", "title": "Send it", "depends_on": ["compile"]},
]


def _project_with_active_plan(env) -> dict:
    client, state = env
    project = _create(env)
    _member(project["id"], "ada", "member")
    _member(project["id"], "tom", "viewer")
    base = f"/api/registry/projects/{project['slug']}/playbook"
    assert client.post(base, json={"body": "Compile, then send.", "steps": STEPS}).status_code == 200
    state["subject"] = "leo"
    assert client.post(f"{base}/1/activate", json={}).status_code == 200
    state["subject"] = ""
    return project


def _url(project, tail="") -> str:
    return f"/api/registry/projects/{project['slug']}/playbook/drafts{tail}"


def test_each_member_drafts_their_own_and_everyone_sees_both(env):
    client, state = env
    project = _project_with_active_plan(env)

    resp = client.put(_url(project, "/me"), json={"body": "Compile, check, then send."})
    assert resp.status_code == 200, resp.text
    leo = resp.json()["draft"]
    assert leo["user_id"] == "leo" and leo["base_rev"] == 1
    assert [s["key"] for s in leo["steps"]] == ["compile", "send"]  # copied from v1

    state["actor"] = MEMBER_P
    resp = client.patch(
        _url(project, "/me/steps/check"),
        json={"step": {"title": "Check the links", "depends_on": ["compile"]}, "after": "compile"},
    )
    assert resp.status_code == 200, resp.text
    ada = resp.json()["draft"]
    assert [s["key"] for s in ada["steps"]] == ["compile", "check", "send"]
    assert ada["body"] == "Compile, then send."  # Leo's prose edit is not hers

    state["actor"] = VIEWER
    listing = client.get(_url(project)).json()
    assert {d["user_id"] for d in listing["drafts"]} == {"leo", "ada"}
    assert listing["can_draft"] is False
    assert not any(d["can_edit"] or d["can_discard"] for d in listing["drafts"])
    assert client.get(_url(project, "/me")).json() == {"draft": None}

    # Leo's draft is untouched by Ada's agent.
    with projects_db.connect_closing() as conn:
        mine = projects_db.get_playbook_draft(conn, project["id"], "leo")
    assert mine["version"] > 0 and len(mine["steps"]) == 2


def test_viewers_and_strangers_cannot_write_a_draft(env):
    client, state = env
    project = _project_with_active_plan(env)
    state["actor"] = VIEWER
    assert client.put(_url(project, "/me"), json={"body": "x"}).status_code == 403
    assert client.patch(_url(project, "/me/steps/x"), json={"step": {"title": "X"}}).status_code == 403
    assert client.post(_url(project, "/me/save"), json={}).status_code == 403
    assert client.delete(_url(project, "/me")).status_code == 403
    state["actor"] = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]
    assert client.get(_url(project)).status_code == 404


def test_only_a_lead_discards_someone_elses_draft(env):
    client, state = env
    project = _project_with_active_plan(env)
    assert client.put(_url(project, "/me"), json={"body": "Leo's idea"}).status_code == 200
    state["actor"] = MEMBER_P
    assert client.put(_url(project, "/me"), json={"body": "Ada's idea"}).status_code == 200

    resp = client.delete(_url(project, "/leo"))
    assert resp.status_code == 403
    assert client.delete(_url(project, "/me")).json() == {"user_id": "ada", "discarded": True}

    assert client.put(_url(project, "/me"), json={"body": "Ada again"}).status_code == 200
    state["actor"] = OWNER
    assert client.delete(_url(project, "/ada")).status_code == 200
    assert client.delete(_url(project, "/ada")).status_code == 404
    assert [d["user_id"] for d in client.get(_url(project)).json()["drafts"]] == ["leo"]


def test_a_stale_write_is_refused_with_the_current_draft(env):
    client, _state = env
    project = _project_with_active_plan(env)
    first = client.put(_url(project, "/me"), json={"body": "one"}).json()["draft"]
    ok = client.put(_url(project, "/me"), json={"body": "two", "expected_version": first["version"]})
    assert ok.status_code == 200 and ok.json()["draft"]["version"] == first["version"] + 1

    stale = client.patch(
        _url(project, "/me/steps/send"),
        json={"step": {"title": "Send late"}, "expected_version": first["version"]},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current"]["body"] == "two"


def test_steps_are_checked_and_removing_one_drops_its_dependents_links(env):
    client, _state = env
    project = _project_with_active_plan(env)
    cyclic = [
        {"key": "a", "title": "A", "depends_on": ["b"]},
        {"key": "b", "title": "B", "depends_on": ["a"]},
    ]
    assert client.put(_url(project, "/me"), json={"steps": cyclic}).status_code == 422
    assert client.patch(_url(project, "/me/steps/new"), json={"step": {"body": "no title"}}).status_code == 422
    assert client.delete(_url(project, "/me/steps/ghost")).status_code == 404

    resp = client.delete(_url(project, "/me/steps/compile"))
    assert resp.status_code == 200, resp.text
    (send,) = resp.json()["draft"]["steps"]
    assert send["key"] == "send" and send["depends_on"] == []


def test_two_drafts_save_as_two_proposals_and_nothing_activates(env):
    client, state = env
    project = _project_with_active_plan(env)
    playbook = f"/api/registry/projects/{project['slug']}/playbook"

    assert client.put(_url(project, "/me"), json={"body": "Leo's take"}).status_code == 200
    state["actor"] = MEMBER_P
    client.patch(_url(project, "/me/steps/check"), json={"step": {"title": "Check"}})

    saved = client.post(_url(project, "/me/save"), json={"note": "add a check"})
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"rev": 2, "active": False, "base_rev": 1}
    assert client.get(_url(project, "/me")).json() == {"draft": None}
    assert client.post(_url(project, "/me/save"), json={}).status_code == 404

    state["actor"] = OWNER
    assert client.post(_url(project, "/me/save"), json={}).json()["rev"] == 3

    data = client.get(playbook).json()
    assert data["active"]["rev"] == 1
    by_rev = {r["rev"]: r for r in data["revisions"]}
    assert by_rev[2]["created_by"] == "ada" and by_rev[2]["base_rev"] == 1
    assert by_rev[2]["note"] == "add a check"
    assert [s["key"] for s in by_rev[2]["steps"]] == ["compile", "send", "check"]
    assert by_rev[3]["created_by"] == "leo" and by_rev[3]["body"] == "Leo's take"
    assert client.get(_url(project)).json()["drafts"] == []


def test_an_agent_write_is_marked_as_the_agents(env):
    client, state = env
    project = _project_with_active_plan(env)
    state["subject"] = ""
    agent = client.put(_url(project, "/me"), json={"body": "by the agent"}).json()["draft"]
    assert agent["updated_by"] == "agent"
    state["subject"] = "leo"
    person = client.put(_url(project, "/me"), json={"body": "by Leo"}).json()["draft"]
    assert person["updated_by"] == "leo"


def test_archived_projects_refuse_draft_writes(env):
    client, _state = env
    project = _project_with_active_plan(env)
    assert client.put(_url(project, "/me"), json={"body": "x"}).status_code == 200
    with projects_db.connect_closing() as conn:
        projects_db.archive_project(conn, project["id"])
    assert client.put(_url(project, "/me"), json={"body": "y"}).status_code in (403, 409)
    assert client.get(_url(project)).status_code == 200


def test_chat_context_tells_the_agent_whose_draft_to_edit(env):
    project = _project_with_active_plan(env)
    with projects_db.connect_closing() as conn:
        record = projects_db.get_project(conn, project["slug"])
        text = projects_chat_api.project_context(conn, record, "ada")
        plain = projects_chat_api.project_context(conn, record)
    assert f"--actor ada playbook {project['slug']} draft" in text
    assert "--actor" not in plain


def test_a_new_draft_never_reuses_an_old_drafts_versions(env):
    client, _state = env
    project = _project_with_active_plan(env)
    old = client.put(_url(project, "/me"), json={"body": "one"}).json()["draft"]
    assert client.delete(_url(project, "/me")).status_code == 200
    client.put(_url(project, "/me"), json={"body": "fresh"})
    stale = client.put(_url(project, "/me"), json={"body": "late", "expected_version": old["version"]})
    assert stale.status_code == 409
    assert stale.json()["detail"]["current"]["body"] == "fresh"


def test_discard_with_a_stale_version_keeps_the_newer_draft(env):
    client, _state = env
    project = _project_with_active_plan(env)
    first = client.put(_url(project, "/me"), json={"body": "one"}).json()["draft"]
    client.put(_url(project, "/me"), json={"body": "two"})
    stale = client.delete(_url(project, f"/me?expected_version={first['version']}"))
    assert stale.status_code == 409
    current = client.get(_url(project, "/me")).json()["draft"]
    assert current["body"] == "two"
    ok = client.delete(_url(project, f"/me?expected_version={current['version']}"))
    assert ok.status_code == 200


def test_drafts_carry_the_owners_display_name(env, monkeypatch):
    client, state = env
    project = _project_with_active_plan(env)

    async def _name(user_id):
        return {"leo": "Leo Lau"}.get(user_id)

    monkeypatch.setattr(projects_chat_api, "_display_name", _name)
    client.put(_url(project, "/me"), json={"body": "Leo's idea"})
    state["actor"] = MEMBER_P
    client.put(_url(project, "/me"), json={"body": "Ada's idea"})

    names = {d["user_id"]: d["display_name"] for d in client.get(_url(project)).json()["drafts"]}
    assert names == {"leo": "Leo Lau", "ada": None}
    assert client.get(_url(project, "/me")).json()["draft"]["display_name"] is None
    state["actor"] = OWNER
    assert client.get(_url(project, "/me")).json()["draft"]["display_name"] == "Leo Lau"


def test_draft_names_never_show_a_login_email(env, monkeypatch):
    """Enrolment stores the email as the display when none was given; drafts show the id instead."""
    from types import SimpleNamespace

    from hermes_cli import console_scope

    client, state = env
    project = _project_with_active_plan(env)
    displays = {"leo": ["leo@example.com", "Leo Lau"], "ada": ["ada@example.com"]}

    async def _enrolments(user_id, store_factory=None):
        return [SimpleNamespace(principal=SimpleNamespace(display=d)) for d in displays[user_id]]

    monkeypatch.setattr(console_scope, "enrolments", _enrolments)
    monkeypatch.setattr(console_scope, "principal_store_factory", lambda: None)
    client.put(_url(project, "/me"), json={"body": "Leo's idea"})
    state["actor"] = MEMBER_P
    client.put(_url(project, "/me"), json={"body": "Ada's idea"})

    names = {d["user_id"]: d["display_name"] for d in client.get(_url(project)).json()["drafts"]}
    assert names == {"leo": "Leo Lau", "ada": None}
