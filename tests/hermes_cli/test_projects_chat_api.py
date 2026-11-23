"""The project chat: one group timeline over per-person, per-profile sessions.

Contracts: each person keeps their own conversation per profile (in that
profile's state.db); the timeline merges every member's linked conversations
and members-only messages, time-ordered and labelled by person and profile;
a viewer reads but never posts; the project context and the catch-up digest ride at
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
from hermes_cli.ref_mentions import with_block
from hermes_cli import projects_api, projects_chat_api, projects_db
from hermes_state import SessionDB

from tests.hermes_cli.test_projects_api import (  # noqa: F401
    MEMBER_P,
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
        v = state["chat_profiles"]
        return set(v.get(user_id, set()) if isinstance(v, dict) else v)

    async def _name(user_id):
        return {"ada": "Ada", "leo": "Leo"}.get(user_id)

    monkeypatch.setattr(projects_chat_api, "_display_name", _name)

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
    digest = projects_chat_api.catch_up_digest(missed)
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


def _join(project, user_id, role="member"):
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=project["id"], user_id=user_id, role=role, added_by="leo"
        )


def _note(env, slug, content):
    return env[0].post(f"/api/registry/projects/{slug}/chat/messages", json={"content": content})


def test_every_members_turns_share_one_timeline_and_reach_each_catch_up(env, project):
    slug = project["slug"]
    _join(project, "ada")
    leo = _session(env, "research", "s-leo")
    _turn(env, slug, "research", leo, "Find sources", "Found three.")

    env[1]["actor"] = MEMBER_P
    ada = _session(env, "research", "s-ada", user="ada")
    out = _prepare(env, slug, "research", ada, "Which is best?")
    # Ada's own conversation in the same profile, catching up on Leo's turn.
    assert out["session_id"] == ada and out["catch_up"] == 2
    assert "- Leo → research: Find sources" in out["message"]
    assert "- research → Leo: Found three." in out["message"]
    _say(env, "research", ada, "user", out["message"])
    _say(env, "research", ada, "assistant", "The second one.")

    tl = _timeline(env, slug)
    assert [(m["person_name"], m["profile"], m["content"]) for m in tl["messages"]] == [
        ("Leo", "research", "Find sources"),
        ("Leo", "research", "Found three."),
        ("Ada", "research", "Which is best?"),
        ("Ada", "research", "The second one."),
    ]
    assert tl["me"] == "ada" and tl["can_post"] is True
    assert tl["sessions"] == [{"profile": "research", "session_id": ada}]
    assert tl["last_profile"] == "research"

    # Back as Leo: his conversation missed exactly Ada's two turns.
    env[1]["actor"] = OWNER
    back = _prepare(env, slug, "research", leo, "Thanks")
    assert back["catch_up"] == 2
    assert "Ada → research: Which is best?" in back["message"]
    assert "Find sources" not in back["message"]
    assert _timeline(env, slug)["sessions"] == [{"profile": "research", "session_id": leo}]


def test_a_members_only_message_reaches_catch_up_but_no_session(env, project):
    slug = project["slug"]
    _join(project, "ada")
    leo = _session(env, "finance", "s-leo")
    _turn(env, slug, "finance", leo, "Cost it", "About $40.")

    env[1]["actor"] = MEMBER_P
    resp = _note(env, slug, "Leo, can you check the FX rate?")
    assert resp.status_code == 200, resp.text
    row = resp.json()
    assert row["member_only"] is True and row["person_name"] == "Ada" and row["profile"] is None
    assert _note(env, slug, "   ").status_code == 422

    env[1]["actor"] = OWNER
    shown = _timeline(env, slug)["messages"]
    assert shown[-1]["content"] == "Leo, can you check the FX rate?" and shown[-1]["member_only"]
    out = _prepare(env, slug, "finance", leo, "Use the FX rate")
    assert out["catch_up"] == 1
    assert "- Ada → members: Leo, can you check the FX rate?" in out["message"]
    db = env[1]["db"]("finance")
    try:
        stored = [m["content"] for m in db.get_messages(leo)]
    finally:
        db.close()
    assert not any("FX rate?" in c for c in stored)


def test_a_viewer_reads_the_group_chat_but_never_posts(env, project):
    slug = project["slug"]
    _join(project, "ada", role="viewer")
    leo = _session(env, "research", "s-leo")
    _turn(env, slug, "research", leo, "Find sources", "Found three.")

    env[1]["actor"] = MEMBER_P
    tl = _timeline(env, slug)
    assert [m["content"] for m in tl["messages"]] == ["Find sources", "Found three."]
    assert tl["can_post"] is False and tl["sessions"] == []
    ada = _session(env, "research", "s-ada", user="ada")
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": "research", "session_id": ada, "message": "hi"},
    )
    assert resp.status_code == 403
    assert _note(env, slug, "hi").status_code == 403


def test_a_member_only_asks_profiles_they_are_enrolled_in(env, project):
    slug = project["slug"]
    _join(project, "ada")
    env[1]["chat_profiles"] = {"leo": {"research", "finance"}, "ada": {"finance"}}
    leo = _session(env, "research", "s-leo")
    _turn(env, slug, "research", leo, "Find sources", "Found three.")

    env[1]["actor"] = MEMBER_P
    ada = _session(env, "research", "s-ada", user="ada")
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": "research", "session_id": ada, "message": "hi"},
    )
    assert resp.status_code == 403
    # She still sees Leo's research turns: membership, not enrolment, gates reading.
    assert len(_timeline(env, slug)["messages"]) == 2


def test_a_stranger_cannot_post_to_the_group_chat(env, project):
    env[1]["actor"] = STRANGER
    assert _note(env, project["slug"], "hi").status_code == 404


def test_a_note_posted_while_a_reply_runs_reaches_the_next_catch_up(env, project):
    slug = project["slug"]
    _join(project, "ada")
    leo = _session(env, "research", "s-leo")
    _turn(env, slug, "research", leo, "Find sources", "Found three.")
    out = _prepare(env, slug, "research", leo, "Rank them")
    # Ada posts after Leo's turn was prepared but before his agent replies.
    env[1]["actor"] = MEMBER_P
    assert _note(env, slug, "Use the 2025 data").status_code == 200
    env[1]["actor"] = OWNER
    _say(env, "research", leo, "user", out["message"])
    _say(env, "research", leo, "assistant", "Ranked.")

    nxt = _prepare(env, slug, "research", leo, "Thanks")
    assert nxt["catch_up"] == 1 and "Ada → members: Use the 2025 data" in nxt["message"]
    _say(env, "research", leo, "user", nxt["message"])
    _say(env, "research", leo, "assistant", "Noted.")
    # Delivered once, never again.
    assert _prepare(env, slug, "research", leo, "Next")["catch_up"] == 0


def test_an_admin_off_the_project_reads_but_never_posts(env, project):
    slug = project["slug"]
    leo = _session(env, "research", "s-leo")
    _turn(env, slug, "research", leo, "Find sources", "Found three.")
    env[1]["actor"] = type(OWNER)(user_id="max", display="Max", role="admin")
    tl = _timeline(env, slug)
    assert len(tl["messages"]) == 2 and tl["can_post"] is False
    assert _note(env, slug, "Use the revised deadline").status_code == 403
    mx = _session(env, "research", "s-max", user="max")
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": "research", "session_id": mx, "message": "hi"},
    )
    assert resp.status_code == 403


def test_an_earlier_private_project_chat_stays_with_its_owner_read_only(env, project):
    slug = project["slug"]
    _join(project, "ada")
    _join(project, "vic", role="viewer")
    old = _session(env, "research", "s-old")
    _say(env, "research", old, "user", "My private draft")
    _say(env, "research", old, "assistant", "Private reply.")
    with projects_db.connect_closing() as conn:
        projects_db.add_project_link(
            conn, project_id=project["id"], kind="conversation",
            profile="research", ref=old, label="project chat", added_by="leo",
        )

    tl = _timeline(env, slug)
    assert [(m["content"], m.get("private")) for m in tl["messages"]] == [
        ("My private draft", True),
        ("Private reply.", True),
    ]
    # Read-only: it is not where the next turn goes, and it cannot join the group.
    assert tl["sessions"] == []
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": "research", "session_id": old, "message": "hi"},
    )
    assert resp.status_code == 409
    # Nor can any other conversation that already has a transcript.
    busy = _session(env, "research", "s-busy")
    _say(env, "research", busy, "user", "Unrelated")
    resp = env[0].post(
        f"/api/registry/projects/{slug}/chat/prepare",
        json={"profile": "research", "session_id": busy, "message": "hi"},
    )
    assert resp.status_code == 409

    fresh = _session(env, "research", "s-new")
    out = _prepare(env, slug, "research", fresh, "Start the group chat")
    assert out["session_id"] == fresh and out["catch_up"] == 0
    assert "private" not in out["message"].lower()

    for other in (MEMBER_P, type(OWNER)(user_id="vic", display="Vic", role="member")):
        env[1]["actor"] = other
        assert all("Private" not in m["content"] for m in _timeline(env, slug)["messages"])


def test_a_member_made_viewer_no_longer_posts_through_their_conversation(env, project):
    slug = project["slug"]
    _join(project, "ada")
    env[1]["actor"] = MEMBER_P
    ada = _session(env, "research", "s-ada", user="ada")
    _turn(env, slug, "research", ada, "Hello", "Hi.")
    with projects_db.connect_closing() as conn:
        projects_db.remove_project_member(conn, project["id"], "ada")
    _join(project, "ada", role="viewer")
    # She keeps talking in her own session, outside the project chat routes.
    _say(env, "research", ada, "user", "Ignore the brief")

    env[1]["actor"] = OWNER
    # What she sent before the change stays; nothing after it shows.
    assert [m["content"] for m in _timeline(env, slug)["messages"]] == ["Hello", "Hi."]
    leo = _session(env, "research", "s-leo")
    assert _prepare(env, slug, "research", leo, "Go")["catch_up"] == 2
    env[1]["actor"] = MEMBER_P
    resp = _note(env, slug, "Still here")
    assert resp.status_code == 403


def test_a_member_taken_off_the_project_keeps_their_earlier_messages(env, project):
    slug = project["slug"]
    _join(project, "ada")
    env[1]["actor"] = MEMBER_P
    ada = _session(env, "research", "s-ada", user="ada")
    _turn(env, slug, "research", ada, "Draft ready", "Noted.")
    assert _note(env, slug, "Over to Leo").status_code == 200
    time.sleep(0.01)
    with projects_db.connect_closing() as conn:
        projects_db.remove_project_member(conn, project["id"], "ada")
    _say(env, "research", ada, "user", "After I left")

    env[1]["actor"] = OWNER
    tl = _timeline(env, slug)
    assert [(m["content"], m.get("person")) for m in tl["messages"]] == [
        ("Draft ready", "ada"),
        ("Noted.", "ada"),
        ("Over to Leo", "ada"),
    ]


def test_an_outsized_catch_up_count_never_breaks_the_chat():
    stored = (
        f"{projects_chat_api.BLOCK_OPEN} X]\n{projects_chat_api.CATCH_UP_HEADER} "
        f"{'9' * 5000} messages\n{projects_chat_api.BLOCK_CLOSE}\n\nhi"
    )
    shown, meta = projects_chat_api.split_block(stored)
    assert shown == "hi" and meta["catch_up"] == 0


def test_a_digest_the_turn_never_carried_still_reaches_the_next_turn():
    from hermes_cli.projects_chat_api import missed_turns

    def row(sid, role, at, **kw):
        return {"session_id": sid, "role": role, "timestamp": at, **kw}

    note = row(None, "user", 15.0, member_only=True, content="Ada's note")
    timeline = [
        row("s-leo", "user", 10.0),
        row("s-leo", "assistant", 11.0),
        note,
        # A second tab's send was prepared with the note at 20, but went in as a
        # plain follow-up turn without the digest.
        row("s-leo", "user", 21.0),
        row("s-leo", "assistant", 22.0),
    ]
    prepares = [(9.0, 0), (20.0, 1)]
    assert missed_turns(timeline, "s-leo", prepares) == [note]
    # Once a turn carries it, it is delivered.
    timeline.append(row("s-leo", "user", 31.0, catch_up=1))
    assert missed_turns(timeline, "s-leo", [*prepares, (30.0, 1)]) == []


def test_a_member_cannot_label_a_conversation_into_the_group_chat(env, project):
    convo = _session(env, "research", "s-mine")
    _say(env, "research", convo, "user", "Something private")
    resp = env[0].post(
        f"/api/registry/projects/{project['slug']}/links",
        json={"kind": "conversation", "ref": convo, "profile": "research",
              "label": "Project Group Chat"},
    )
    assert resp.status_code == 422
    assert _timeline(env, project["slug"])["messages"] == []


def _media(env, slug, path):
    return env[0].get(f"/api/registry/projects/{slug}/chat/media", params={"path": path})


def test_a_file_attached_in_the_group_chat_opens_for_everyone_on_the_project(env, project):
    slug = project["slug"]
    _join(project, "ada")
    _join(project, "vic", role="viewer")
    shared = "leo/s-leo/u1-chart.png"
    leo = _session(env, "research", "s-leo")
    out = _prepare(env, slug, "research", leo, "See the chart")
    _say(env, "research", leo, "user",
         out["message"] + "\n![chart](/api/chat/media?path=leo%2Fs-leo%2Fu1-chart.png)")
    _say(env, "research", leo, "assistant", "Looks good.")
    assert _media(env, slug, shared).status_code == 200

    env[1]["actor"] = MEMBER_P
    # Ada names one of Leo's files he never attached here: it stays his.
    assert _note(env, slug, "![x](/api/chat/media?path=leo%2Fs-x%2Fu9-secret.png)").status_code == 200
    viewer = type(OWNER)(user_id="vic", display="Vic", role="member")
    outsider = type(OWNER)(user_id="zed", display="Zed", role="member")
    for who in (MEMBER_P, viewer):
        env[1]["actor"] = who
        assert _media(env, slug, shared).status_code == 200
        assert _media(env, slug, "leo/s-x/u9-secret.png").status_code == 403
        assert _media(env, slug, "leo/s-leo/u2-other.png").status_code == 403
    env[1]["actor"] = outsider
    assert _media(env, slug, shared).status_code in (403, 404)


def test_follow_ups_queued_before_a_demotion_stay_with_their_replies(env, project):
    slug = project["slug"]
    _join(project, "ada")
    env[1]["actor"] = MEMBER_P
    ada = _session(env, "research", "s-ada", user="ada")
    out = _prepare(env, slug, "research", ada, "Draft the summary")
    _say(env, "research", ada, "user", out["message"])
    # Both sent while that turn worked; they run after Ada is made a viewer.
    first_sent = time.time()
    time.sleep(0.01)
    second_sent = time.time()
    time.sleep(0.01)
    with projects_db.connect_closing() as conn:
        projects_db.remove_project_member(conn, project["id"], "ada")
    _join(project, "ada", role="viewer")
    _say(env, "research", ada, "assistant", "Drafted.")
    for typed, reply, sent in (
        ("Use the May totals", "Updated.", first_sent),
        ("Add a chart", "Added.", second_sent),
    ):
        with projects_db.connect_closing() as conn:
            projects_db.record_chat_input(conn, ada, sent)
        time.sleep(0.01)
        _say(env, "research", ada, "user", typed)
        _say(env, "research", ada, "assistant", reply)
    _say(env, "research", ada, "user", "Sent after the change")
    _say(env, "research", ada, "assistant", "Hidden.")

    env[1]["actor"] = OWNER
    assert [m["content"] for m in _timeline(env, slug)["messages"]] == [
        "Draft the summary", "Drafted.", "Use the May totals", "Updated.", "Add a chart", "Added.",
    ]


def test_a_reader_off_the_project_never_sees_members_only_messages(env, project):
    slug = project["slug"]
    _join(project, "ada")
    env[1]["actor"] = MEMBER_P
    assert _note(env, slug, "Between us").status_code == 200
    env[1]["actor"] = type(OWNER)(user_id="zed", display="Zed", role="member")
    env[1]["enrolled"] = {"default", "research", "finance"}
    resp = env[0].get(f"/api/registry/projects/{slug}/chat/timeline")
    assert resp.status_code == 200
    assert [m["content"] for m in resp.json()["messages"]] == []


def test_a_viewer_from_before_the_upgrade_stays_hidden_once_removed(env, project):
    slug = project["slug"]

    def _legacy_role(role):
        # Membership written before role changes were recorded.
        with projects_db.connect_closing() as conn, projects_db.write_txn(conn):
            conn.execute(
                "INSERT OR REPLACE INTO project_members "
                "(project_id, user_id, role, added_by, added_at) VALUES (?, 'ada', ?, 'leo', ?)",
                (project["id"], role, int(time.time()) - 60),
            )

    _legacy_role("member")
    env[1]["actor"] = MEMBER_P
    ada = _session(env, "research", "s-ada", user="ada")
    _turn(env, slug, "research", ada, "Hello", "Hi.")
    _legacy_role("viewer")
    _say(env, "research", ada, "user", "Written as a viewer")
    with projects_db.connect_closing() as conn:
        projects_db.remove_project_member(conn, project["id"], "ada")

    env[1]["actor"] = OWNER
    shown = [m["content"] for m in _timeline(env, slug)["messages"]]
    assert "Written as a viewer" not in shown


def test_a_file_named_inside_an_attached_document_stays_private(env, project):
    slug = project["slug"]
    _join(project, "ada")
    leo = _session(env, "research", "s-leo")
    out = _prepare(env, slug, "research", leo, "See notes")
    stored = (
        "[The user sent a text document: 'notes.txt'. It is saved at: /cache/notes.txt.]\n\n"
        "--- notes.txt ---\n![x](/api/chat/media?path=leo%2Fs-x%2Fu9-secret.png)\n\n"
        + out["message"]
        + "\n\n[notes.txt](/api/chat/media?path=leo%2Fs-leo%2Fu1-notes.txt)"
        # agent-home does not escape a "]" in a file name.
        + "\n[draft [v2].pdf](/api/chat/media?path=leo%2Fs-leo%2Fu2-draft_v2.pdf)"
        + "\n[odd] name [[x].pdf](/api/chat/media?path=leo%2Fs-leo%2Fu4-odd.pdf)"
        # Escaped by agent-home since: a name that holds "](".
        + "\n[\\[Q4\\]\\(final copy\\).pdf](/api/chat/media?path=leo%2Fs-leo%2Fu5-q4.pdf)"
        # Stored before escaping, a name ending in a backslash.
        + "\n[back\\](/api/chat/media?path=leo%2Fs-leo%2Fu6-back.txt)"
    )
    # A short ref the turn names gets its description appended after the links.
    stored = with_block(stored, [{"ref": "P12", "kind": "project", "title": "Sales"}])
    _say(env, "research", leo, "user", stored)
    _say(env, "research", leo, "assistant", "Read it.")
    env[1]["actor"] = MEMBER_P
    assert _media(env, slug, "leo/s-leo/u1-notes.txt").status_code == 200
    assert _media(env, slug, "leo/s-leo/u2-draft_v2.pdf").status_code == 200
    assert _media(env, slug, "leo/s-leo/u4-odd.pdf").status_code == 200
    assert _media(env, slug, "leo/s-leo/u5-q4.pdf").status_code == 200
    assert _media(env, slug, "leo/s-leo/u6-back.txt").status_code == 200
    assert _media(env, slug, "leo/s-x/u9-secret.png").status_code == 403


def test_a_merged_turn_with_a_part_sent_as_a_viewer_stays_hidden(env, project):
    slug = project["slug"]
    _join(project, "ada")
    env[1]["actor"] = MEMBER_P
    ada = _session(env, "research", "s-ada", user="ada")
    _turn(env, slug, "research", ada, "Hello", "Hi.")
    with projects_db.connect_closing() as conn:
        projects_db.remove_project_member(conn, project["id"], "ada")
    _join(project, "ada", role="viewer")
    as_viewer = time.time()
    time.sleep(0.01)
    with projects_db.connect_closing() as conn:
        projects_db.remove_project_member(conn, project["id"], "ada")
    _join(project, "ada")
    time.sleep(0.01)
    reinstated = time.time()
    # Two steers the turn never read, merged into one follow-up turn.
    with projects_db.connect_closing() as conn:
        for sent in (as_viewer, reinstated):
            projects_db.record_chat_input(conn, ada, sent)
    time.sleep(0.01)
    _say(env, "research", ada, "user", "sent as a viewer\nsent as a member")
    _say(env, "research", ada, "assistant", "Merged.")

    env[1]["actor"] = OWNER
    assert [m["content"] for m in _timeline(env, slug)["messages"]] == ["Hello", "Hi."]


def test_a_line_of_several_links_shares_none_of_them(env, project):
    slug = project["slug"]
    _join(project, "ada")
    leo = _session(env, "research", "s-leo")
    out = _prepare(env, slug, "research", leo, "See these")
    stored = (
        out["message"]
        + "\n\n[a](/api/chat/media?path=leo%2Fs-x%2Fu9-secret.png) and "
        + "[b](/api/chat/media?path=leo%2Fs-leo%2Fu1-b.pdf)"
        + "\n[c.pdf](/api/chat/media?path=leo%2Fs-leo%2Fu3-c.pdf)"
    )
    _say(env, "research", leo, "user", stored)
    _say(env, "research", leo, "assistant", "Seen.")
    env[1]["actor"] = MEMBER_P
    assert _media(env, slug, "leo/s-leo/u3-c.pdf").status_code == 200
    assert _media(env, slug, "leo/s-x/u9-secret.png").status_code == 403
    assert _media(env, slug, "leo/s-leo/u1-b.pdf").status_code == 403
