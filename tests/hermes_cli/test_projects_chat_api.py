"""The project chat: one timeline over per-profile sessions.

Contracts: each profile keeps its own conversation (its own state.db); the
timeline merges only the caller's linked conversations, time-ordered and
labelled by profile; the project context and the catch-up digest ride at
the top of the *same* user turn (never a system prompt edit, never an
extra message); the context is seeded once per conversation; a stranger's
session can never be linked; playbook revisions saved during the chat come
back as proposals.
"""

from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.prompt_builder import format_steer_marker
from hermes_cli import projects_api, projects_chat_api, projects_db
from hermes_state import SessionDB

from tests.hermes_cli.test_projects_api import (  # noqa: F401
    OWNER,
    STRANGER,
    _activate,
    _create,
)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    state = {"actor": OWNER, "enrolled": set(), "subject": ""}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set(state["enrolled"])

    async def _subject(request):
        return state["subject"]

    def _db(profile):
        (tmp_path / profile).mkdir(exist_ok=True)
        return SessionDB(db_path=tmp_path / profile / "state.db")

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)
    monkeypatch.setattr(projects_chat_api, "_session_db", _db)
    state["chat_profiles"] = {"default", "research", "finance"}

    async def _chat_profiles(user_id):
        return set(state["chat_profiles"])

    monkeypatch.setattr(projects_chat_api, "_chat_profiles", _chat_profiles)

    app = FastAPI()
    app.include_router(projects_api.router)
    app.include_router(projects_chat_api.router)
    state["db"] = _db
    return TestClient(app), state


def _session(env, profile, sid, user="leo"):
    db = env[1]["db"](profile)
    try:
        db.create_session(sid, "web", user_id=user)
    finally:
        db.close()
    return sid


def _say(env, profile, sid, role, content):
    db = env[1]["db"](profile)
    try:
        db.append_message(sid, role, content)
    finally:
        db.close()
    time.sleep(0.01)


def _prepare(env, slug, profile, sid, message):
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": profile, "session_id": sid, "message": message},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _turn(env, slug, profile, sid, typed, reply):
    """What agent-home does: prepare, then the agent stores the turn."""
    out = _prepare(env, slug, profile, sid, typed)
    _say(env, profile, sid, "user", out["message"])
    _say(env, profile, sid, "assistant", reply)
    return out


def _timeline(env, slug):
    resp = env[0].get(f"/api/registry/projects/{slug}/chat/timeline")
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def project(env):
    p = _create(env)
    _activate(env, p)
    return p


def test_first_turn_is_seeded_once_and_typed_text_survives(env, project):
    slug = project["slug"]
    sid = _session(env, "research", "s-research")
    first = _turn(env, slug, "research", sid, "Plan the digest", "Here is a plan.")
    assert first["seeded"] is True
    assert first["message"].endswith("Plan the digest")
    assert projects_chat_api.CONTEXT_HEADER in first["message"]
    assert project["goal"].split(" —")[0] in first["message"]

    second = _prepare(env, slug, "research", sid, "Shorter please")
    assert second["seeded"] is False
    assert second["message"] == "Shorter please"


def test_app_context_line_stays_first(env, project):
    sid = _session(env, "research", "s1")
    msg = "[app context: Projects › Digest]\nWhat next?"
    out = _prepare(env, project["slug"], "research", sid, msg)
    assert out["message"].startswith("[app context: Projects › Digest]\n")
    assert out["message"].endswith("\n\nWhat next?")
    shown, meta = projects_chat_api.split_block(out["message"])
    assert shown == msg and meta["seeded"] is True


def test_switching_profile_carries_a_catch_up_of_missed_turns(env, project):
    slug = project["slug"]
    r = _session(env, "research", "s-r")
    f = _session(env, "finance", "s-f")
    _turn(env, slug, "research", r, "Find sources", "Found three.")
    _turn(env, slug, "research", r, "Which is best?", "The second one.")

    out = _prepare(env, slug, "finance", f, "Cost it out")
    assert out["catch_up"] == 4
    assert out["seeded"] is True
    assert "Found three." in out["message"] and "The second one." in out["message"]
    _say(env, "finance", f, "user", out["message"])
    _say(env, "finance", f, "assistant", "About $40.")

    # Back to research: it only missed finance's two turns, not its own.
    back = _prepare(env, slug, "research", r, "Thanks")
    assert back["catch_up"] == 2
    assert "About $40." in back["message"] and "Found three." not in back["message"]
    # Nothing missed → the typed text goes as-is.
    _say(env, "research", r, "user", back["message"])
    _say(env, "research", r, "assistant", "Welcome.")
    assert _prepare(env, slug, "research", r, "Again")["message"] == "Again"


def test_each_profile_keeps_its_own_session_and_alternation(env, project):
    slug = project["slug"]
    r = _session(env, "research", "s-r")
    f = _session(env, "finance", "s-f")
    _turn(env, slug, "research", r, "A", "a")
    _turn(env, slug, "finance", f, "B", "b")
    _turn(env, slug, "research", r, "C", "c")
    for profile, sid in (("research", r), ("finance", f)):
        db = env[1]["db"](profile)
        try:
            roles = [m["role"] for m in db.get_messages(sid)]
        finally:
            db.close()
        assert all(a != b for a, b in zip(roles, roles[1:])), roles
    # Neither store holds the other profile's session.
    db = env[1]["db"]("finance")
    try:
        assert db.get_session(r) is None
    finally:
        db.close()


def test_timeline_is_merged_in_order_labelled_and_stripped(env, project):
    slug = project["slug"]
    r = _session(env, "research", "s-r")
    f = _session(env, "finance", "s-f")
    _turn(env, slug, "research", r, "A", "a")
    _turn(env, slug, "finance", f, "B", "b")
    _turn(env, slug, "research", r, "C", "c")
    tl = _timeline(env, slug)
    assert [(m["profile"], m["content"]) for m in tl["messages"]] == [
        ("research", "A"), ("research", "a"),
        ("finance", "B"), ("finance", "b"),
        ("research", "C"), ("research", "c"),
    ]
    stamps = [m["timestamp"] for m in tl["messages"]]
    assert stamps == sorted(stamps)
    by = {m["content"]: m for m in tl["messages"]}
    assert by["A"]["seeded"] and by["B"]["seeded"] and not by["C"]["seeded"]
    assert by["B"]["catch_up"] == 2 and by["C"]["catch_up"] == 2
    assert {s["profile"]: s["session_id"] for s in tl["sessions"]} == {
        "research": r, "finance": f,
    }
    assert tl["last_profile"] == "research"


def test_another_persons_chat_is_neither_linked_nor_shown(env, project):
    slug = project["slug"]
    theirs = _session(env, "research", "s-eve", user="eve")
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": "research", "session_id": theirs, "message": "hi"},
    )
    assert resp.status_code == 404
    with projects_db.connect_closing() as conn:
        assert projects_db.get_project_links(conn, project["id"], kind="conversation") == []

    # A link that exists anyway (CLI, older data) is still filtered by owner.
    with projects_db.connect_closing() as conn:
        projects_db.add_project_link(
            conn, project_id=project["id"], kind="conversation",
            profile="research", ref=theirs, label="project chat", added_by="leo",
        )
    _say(env, "research", theirs, "user", "secret")
    assert _timeline(env, slug)["messages"] == []


def test_a_stranger_cannot_read_the_project_chat(env, project):
    env[1]["actor"] = STRANGER
    resp = env[0].get(f"/api/registry/projects/{project['slug']}/chat/timeline")
    assert resp.status_code == 404


def test_playbook_saved_during_the_chat_comes_back_as_a_proposal(env, project):
    slug, pid = project["slug"], project["id"]
    with projects_db.connect_closing() as conn:
        base = projects_db.save_playbook_rev(
            conn, project_id=pid,
            steps=[{"key": "a", "title": "Pull"}, {"key": "b", "title": "Draft"}],
        )
        projects_db.activate_playbook_rev(conn, pid, base)
    r = _session(env, "research", "s-r")
    first = _turn(env, slug, "research", r, "Improve it", "Proposed v2.")
    assert f"Active playbook v{base}" in first["message"]
    with projects_db.connect_closing() as conn:
        conn.execute(
            "UPDATE project_playbook SET created_at = 0 WHERE project_id = ?", (pid,)
        )
        conn.commit()
        rev = projects_db.save_playbook_rev(
            conn, project_id=pid, created_by="research",
            steps=[
                {"key": "a", "title": "Pull"},
                {"key": "b", "title": "Draft carefully"},
                {"key": "c", "title": "Flag outliers"},
            ],
        )
    proposals = _timeline(env, slug)["proposals"]
    assert [p["rev"] for p in proposals] == [rev]
    p = proposals[0]
    assert (p["added"], p["changed"], p["removed"]) == (1, 1, 0)
    assert p["added_titles"] == ["Flag outliers"]
    assert p["base_rev"] == base and p["active"] is False


def test_catch_up_digest_is_bounded():
    missed = [
        {"role": "assistant", "profile": "p", "content": "x" * 5000, "timestamp": i}
        for i in range(40)
    ]
    digest = projects_chat_api.catch_up_digest(missed, "q")
    assert digest.startswith(f"{projects_chat_api.CATCH_UP_HEADER} 40 ")
    assert len(digest.splitlines()) == projects_chat_api.CATCH_UP_MAX_TURNS + 1
    assert len(digest) < (projects_chat_api.CATCH_UP_TURN_CHARS + 20) * 10


def test_an_attached_conversation_never_becomes_the_chat_destination(env, project):
    slug = project["slug"]
    r = _session(env, "research", "s-r")
    _turn(env, slug, "research", r, "Find sources", "Found three.")
    other = _session(env, "research", "s-invoices")
    with projects_db.connect_closing() as conn:
        projects_db.add_project_link(
            conn, project_id=project["id"], kind="conversation",
            profile="research", ref=other, label="Invoices", added_by="leo",
        )
    assert _timeline(env, slug)["sessions"] == [{"profile": "research", "session_id": r}]
    # A second page that opened its own fresh session still lands in the canonical one.
    fresh = _session(env, "research", "s-fresh")
    assert _prepare(env, slug, "research", fresh, "More?")["session_id"] == r


def test_a_suspended_profile_is_neither_shown_nor_addressable(env, project):
    slug = project["slug"]
    r = _session(env, "research", "s-r")
    _turn(env, slug, "research", r, "Find sources", "Found three.")
    env[1]["chat_profiles"] = {"default", "finance"}
    assert _timeline(env, slug)["messages"] == []
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": "research", "session_id": r, "message": "hi"},
    )
    assert resp.status_code == 403


def test_attachment_notes_and_steers_reach_the_timeline_and_catch_up(env, project):
    slug = project["slug"]
    r = _session(env, "research", "s-r")
    f = _session(env, "finance", "s-f")
    out = _prepare(env, slug, "research", r, "Compare the last two entries")
    note = "[The user sent an image: 'a.png'. It is saved at: /c/a.png.]"
    _say(env, "research", r, "user", f"{note}\n\n{out['message']}")
    _say(env, "research", r, "tool", "ok\n\n" + format_steer_marker("Only this year"))
    _say(env, "research", r, "assistant", "Done.")

    rows = _timeline(env, slug)["messages"]
    first = rows[0]
    assert first["seeded"] is True and "[project chat:" not in first["content"]
    assert first["content"].startswith(note)
    steer = [m for m in rows if m.get("sent_while_working")]
    assert [m["content"] for m in steer] == ["Only this year"]

    digest = _prepare(env, slug, "finance", f, "Cost it")["message"]
    assert "Compare the last two entries" in digest and "Only this year" in digest
    assert "a.png" not in digest
