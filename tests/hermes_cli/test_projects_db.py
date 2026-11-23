"""Tests for the shared-root Projects store (hermes_cli/projects_db).

Root anchoring + the legacy import live in test_projects_root_store.py;
this file covers the record CRUD and the §2.2 store-level constraints.
"""

from __future__ import annotations

import pytest

from hermes_cli import projects_db as pdb


@pytest.fixture
def conn(tmp_path):
    c = pdb.connect(db_path=tmp_path / "projects.db")
    try:
        yield c
    finally:
        c.close()


def test_record_and_list_discovered_repos(conn):
    n = pdb.record_discovered_repos(conn, [("/www/alpha", "alpha"), ("/www/beta", None)])
    assert n == 2

    rows = {r["root"]: r["label"] for r in pdb.list_discovered_repos(conn)}
    assert rows["/www/alpha"] == "alpha"
    # Label defaults to the basename when not given.
    assert rows["/www/beta"] == "beta"


def test_record_discovered_repos_upserts(conn):
    pdb.record_discovered_repos(conn, [("/www/alpha", "old")])
    pdb.record_discovered_repos(conn, [("/www/alpha", "new")])

    rows = pdb.list_discovered_repos(conn)
    assert len(rows) == 1
    assert rows[0]["label"] == "new"


def test_record_discovered_repos_replace_drops_stale_rows(conn):
    pdb.record_discovered_repos(conn, [("/www/alpha", "alpha"), ("/www/beta", "beta")])
    pdb.record_discovered_repos(conn, [("/www/alpha", "fresh")], replace=True)

    rows = {r["root"]: r["label"] for r in pdb.list_discovered_repos(conn)}
    assert rows == {"/www/alpha": "fresh"}


def test_create_get_list(conn):
    pid = pdb.create_project(conn, name="Hermes Agent", folders=["/tmp/hermes"])
    proj = pdb.get_project(conn, pid)

    assert proj is not None
    assert proj.slug == "hermes-agent"
    assert proj.name == "Hermes Agent"
    # First folder becomes primary.
    assert proj.primary_path == "/tmp/hermes"
    assert [f.path for f in proj.folders] == ["/tmp/hermes"]
    assert proj.folders[0].is_primary is True

    # Lookup by slug too.
    assert pdb.get_project(conn, "hermes-agent").id == pid
    assert len(pdb.list_projects(conn)) == 1


def test_slug_collision_disambiguates(conn):
    pdb.create_project(conn, name="Hermes Agent")
    pdb.create_project(conn, name="Hermes Agent")
    slugs = sorted(p.slug for p in pdb.list_projects(conn))

    assert slugs == ["hermes-agent", "hermes-agent-2"]


def test_empty_name_rejected(conn):
    with pytest.raises(ValueError):
        pdb.create_project(conn, name="   ")


def test_add_remove_folder_and_primary_repoint(conn):
    pid = pdb.create_project(conn, name="P", folders=["/a"])
    pdb.add_folder(conn, pid, "/b")
    pdb.add_folder(conn, pid, "/c", is_primary=True)

    proj = pdb.get_project(conn, pid)
    assert proj.primary_path == "/c"
    assert {f.path for f in proj.folders} == {"/a", "/b", "/c"}

    # Removing the primary repoints to the oldest remaining folder.
    pdb.remove_folder(conn, pid, "/c")
    proj = pdb.get_project(conn, pid)
    assert proj.primary_path == "/a"

    # Removing the last folder clears the primary.
    pdb.remove_folder(conn, pid, "/a")
    pdb.remove_folder(conn, pid, "/b")
    proj = pdb.get_project(conn, pid)
    assert proj.primary_path is None
    assert proj.folders == []


def test_set_primary_requires_existing_folder(conn):
    pid = pdb.create_project(conn, name="P", folders=["/a"])
    assert pdb.set_primary(conn, pid, "/nope") is False
    assert pdb.set_primary(conn, pid, "/a") is True


def test_paths_normalized(conn):
    pid = pdb.create_project(conn, name="P", folders=["/a/b/../c/"])
    proj = pdb.get_project(conn, pid)
    # Trailing slash stripped, .. collapsed.
    assert proj.primary_path == "/a/c"


def test_project_for_path_longest_prefix(conn):
    outer = pdb.create_project(conn, name="Outer", folders=["/www"])
    inner = pdb.create_project(conn, name="Inner", folders=["/www/app"])

    assert pdb.project_for_path(conn, "/www/app/src/x.py").id == inner
    assert pdb.project_for_path(conn, "/www/other").id == outer
    assert pdb.project_for_path(conn, "/elsewhere") is None
    # Segment-wise prefix only: /www/app must not match /www/application.
    assert pdb.project_for_path(conn, "/www/application").id == outer


def test_project_for_path_skips_archived(conn):
    pid = pdb.create_project(conn, name="P", folders=["/www/app"])
    pdb.archive_project(conn, pid)

    assert pdb.project_for_path(conn, "/www/app/src") is None
    # Archived hidden from the default list but visible with include_archived.
    assert pdb.list_projects(conn) == []
    assert len(pdb.list_projects(conn, include_archived=True)) == 1

    pdb.restore_project(conn, pid)
    assert pdb.project_for_path(conn, "/www/app/src").id == pid


def test_active_pointer(conn):
    pid = pdb.create_project(conn, name="P")
    assert pdb.get_active_id(conn) is None

    pdb.set_active(conn, pid)
    assert pdb.get_active_id(conn) == pid

    pdb.set_active(conn, None)
    assert pdb.get_active_id(conn) is None


def test_branch_name_for_is_deterministic():
    proj = pdb.Project(id="p_1", slug="web-app", name="Web App", created_at=0)

    assert pdb.branch_name_for(proj, "t_abc") == "web-app/t_abc"
    assert pdb.branch_name_for(proj, "t_abc", title="Add login!") == "web-app/t_abc-add-login"
    # Stable across calls.
    assert pdb.branch_name_for(proj, "t_abc") == pdb.branch_name_for(proj, "t_abc")


def test_per_profile_isolation(tmp_path):
    # Two distinct DB paths stand in for two profiles' HERMES_HOME.
    a = pdb.connect(db_path=tmp_path / "a" / "projects.db")
    b = pdb.connect(db_path=tmp_path / "b" / "projects.db")
    try:
        pdb.create_project(a, name="Only In A", folders=["/a"])

        assert [p.slug for p in pdb.list_projects(a)] == ["only-in-a"]
        assert pdb.list_projects(b) == []
    finally:
        a.close()
        b.close()


def test_db_path_root_anchored():
    # The store resolves through the same resolver the kanban board uses.
    # (In tests HERMES_HOME is a custom layout, so kanban_home() ==
    # HERMES_HOME and the path still lands under the isolated home.)
    from hermes_cli.kanban_db import kanban_home

    assert pdb.projects_db_path() == kanban_home() / "projects.db"


def test_db_path_env_override(tmp_path, monkeypatch):
    # HERMES_PROJECTS_DB is the explicit override — and the reversibility
    # lever for the root migration.
    target = tmp_path / "elsewhere" / "projects.db"
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(target))
    assert pdb.projects_db_path() == target


def test_legacy_profile_path_still_named():
    # The old per-profile location stays nameable (backups, diagnostics).
    assert pdb.legacy_profile_projects_db_path().name == "projects.db"


# ---------------------------------------------------------------------------
# §2.2 store-level constraints
# ---------------------------------------------------------------------------


def test_name_capped_at_60_chars(conn):
    with pytest.raises(ValueError, match="name"):
        pdb.create_project(conn, name="x" * 61)


def test_goal_capped_at_160_chars(conn):
    with pytest.raises(ValueError, match="goal"):
        pdb.create_project(conn, name="P", goal="g" * 161)


def test_create_full_project_requires_goal_and_description(conn):
    with pytest.raises(ValueError, match="goal"):
        pdb.create_full_project(conn, goal="   ", description="brief")
    with pytest.raises(ValueError, match="description"):
        pdb.create_full_project(conn, goal="Ship the thing", description="  ")


def test_create_full_project_lands_in_planning(conn):
    pid = pdb.create_full_project(
        conn, goal="Acme is live on prod with the team trained", description="brief"
    )
    proj = pdb.get_project(conn, pid)
    assert proj.status == "planning"
    assert proj.cadence == "one_off"
    assert proj.autonomy == "supervised"


def test_name_defaults_from_goal_leading_clause(conn):
    # Em-dash, colon and period split the leading clause; otherwise the
    # first six words.
    pid = pdb.create_full_project(
        conn, goal="Land Q3 revenue — Acme rollout and training", description="d"
    )
    assert pdb.get_project(conn, pid).name == "Land Q3 revenue"

    pid = pdb.create_full_project(
        conn, goal="Send the Monday digest: weekly summary mail", description="d"
    )
    assert pdb.get_project(conn, pid).name == "Send the Monday digest"

    pid = pdb.create_full_project(
        conn,
        goal="One two three four five six seven eight nine ten",
        description="d",
    )
    assert pdb.get_project(conn, pid).name == "One two three four five six"


def test_goal_and_name_edit_independently(conn):
    pid = pdb.create_full_project(conn, goal="First goal sentence", description="d")
    # Re-wording the goal never renames the project…
    pdb.update_project(conn, pid, goal="Second goal sentence")
    proj = pdb.get_project(conn, pid)
    assert proj.goal == "Second goal sentence"
    assert proj.name == "First goal sentence"
    # …and renaming never rewrites the goal.
    pdb.update_project(conn, pid, name="New Label")
    proj = pdb.get_project(conn, pid)
    assert proj.name == "New Label"
    assert proj.goal == "Second goal sentence"
    # The store re-validates on patch.
    with pytest.raises(ValueError, match="goal"):
        pdb.update_project(conn, pid, goal="g" * 161)


def _seed_planning_row(conn, pid):
    """Write the §2.2 gate rows (output + member + profile) directly."""
    import time

    from hermes_cli.sqlite_util import write_txn

    now = int(time.time())
    with write_txn(conn):
        conn.execute(
            "INSERT INTO project_outputs "
            "(id, project_id, seq, title, created_at) VALUES (?, ?, 1, 'Out', ?)",
            ("o_1", pid, now),
        )
    pdb.add_project_member(conn, project_id=pid, user_id="u1", role="lead")
    pdb.add_project_profile(conn, project_id=pid, profile="default")


def test_leaving_planning_refused_until_gate_rows_exist(conn):
    pid = pdb.create_full_project(conn, goal="Gate test", description="d")

    with pytest.raises(ValueError, match="output") as exc:
        pdb.set_project_status(conn, pid, "active")
    # Every missing piece is named.
    assert "member" in str(exc.value) and "profile" in str(exc.value)

    _seed_planning_row(conn, pid)
    assert pdb.set_project_status(conn, pid, "active") is True
    assert pdb.get_project(conn, pid).status == "active"


def test_status_vocabulary_validated(conn):
    pid = pdb.create_project(conn, name="P")
    with pytest.raises(ValueError, match="status"):
        pdb.set_project_status(conn, pid, "shipping")


def test_member_roles_validated_and_deduplicated(conn):
    pid = pdb.create_project(conn, name="P")
    with pytest.raises(ValueError, match="role"):
        pdb.add_project_member(conn, project_id=pid, user_id="u1", role="boss")

    assert pdb.add_project_member(conn, project_id=pid, user_id="u1", role="lead") is True
    assert pdb.add_project_member(conn, project_id=pid, user_id="u1") is False
    members = pdb.get_project_members(conn, pid)
    assert [m["user_id"] for m in members] == ["u1"]
    assert members[0]["role"] == "lead"

    assert pdb.remove_project_member(conn, pid, "u1") is True
    assert pdb.get_project_members(conn, pid) == []


def test_list_playbook_revs_carries_decoded_steps(conn):
    """A proposed (not yet active) revision must list its saved steps —
    the plan panel renders them before activation."""
    pid = pdb.create_project(conn, name="Steps Listed", folders=["/tmp/steps"])
    steps = [
        {"key": "draft", "title": "Draft it"},
        {"key": "review", "title": "Review it", "depends_on": ["draft"], "checkpoint": True},
    ]
    rev = pdb.save_playbook_rev(conn, project_id=pid, body="two steps", steps=steps)
    revs = pdb.list_playbook_revs(conn, pid)
    assert [r["rev"] for r in revs] == [rev]
    assert revs[0]["active"] in (0, False)
    assert [s["key"] for s in revs[0]["steps"]] == ["draft", "review"]
    assert revs[0]["steps"][1]["checkpoint"] is True


def _steps(*pairs):
    return [{"key": k, "title": t} for k, t in pairs]


def test_several_proposals_wait_at_once_each_recording_its_base(conn):
    """v5 active, v6 proposed, an edit of v6 is v7 — nothing is overwritten,
    and each proposal names the revision it was written from."""
    pid = pdb.create_project(conn, name="Many Proposals", folders=["/tmp/many"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    pdb.activate_playbook_rev(conn, pid, v1)
    v2 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A2")))
    v3 = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("a", "A3")), base_rev=v2
    )
    revs = {r["rev"]: r for r in pdb.list_playbook_revs(conn, pid)}
    assert revs[v2]["base_rev"] == v1  # defaults to the active revision
    assert revs[v3]["base_rev"] == v2
    assert not revs[v2]["active"] and not revs[v3]["active"]
    assert revs[v2]["steps"][0]["title"] == "A2"

    # Making one active leaves the other proposed; the superseded rev keeps
    # its activation time (it was in use once — history, not a proposal).
    pdb.activate_playbook_rev(conn, pid, v3)
    revs = {r["rev"]: r for r in pdb.list_playbook_revs(conn, pid)}
    assert revs[v3]["active"]
    assert not revs[v2]["active"] and revs[v2]["activated_at"] is None
    assert revs[v1]["activated_at"] is not None


def test_merge_keeps_both_sides_changes_and_names_conflicts():
    base = {"body": "b", "steps": _steps(("a", "A"), ("b", "B"), ("c", "C"))}
    proposal = {
        "body": "b",
        "steps": [
            {"key": "a", "title": "A (3h)"},
            {"key": "b", "title": "B mine"},
            {"key": "c", "title": "C"},
            {"key": "n", "title": "New mine", "depends_on": ["c"]},
        ],
    }
    active = {
        "body": "b theirs",
        "steps": [
            {"key": "a", "title": "A"},
            {"key": "b", "title": "B theirs"},
            {"key": "x", "title": "Added there"},
        ],
    }
    body, steps, conflicts = pdb.merge_playbook_onto(base, proposal, active)
    titles = {s["key"]: s["title"] for s in steps}
    assert body == "b theirs"  # only the active side changed the body
    assert titles["a"] == "A (3h)"  # only the proposal changed it
    assert titles["b"] == "B mine" and conflicts == ["b"]  # both: mine kept, named
    assert "c" not in titles  # the active side removed it, the proposal didn't touch it
    assert titles["x"] == "Added there" and titles["n"] == "New mine"
    # A dependency on a step that no longer exists is dropped, not left dangling.
    assert next(s for s in steps if s["key"] == "n")["depends_on"] == []


def test_rebase_moves_a_stale_proposal_onto_the_active_revision(conn):
    pid = pdb.create_project(conn, name="Rebase", folders=["/tmp/rebase"])
    v1 = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("pull", "Pull CRM export"), ("send", "Send"))
    )
    pdb.activate_playbook_rev(conn, pid, v1)
    agent = pdb.save_playbook_rev(
        conn, project_id=pid,
        steps=_steps(("pull", "Pull CRM export"), ("send", "Send to the list")),
    )
    mine = pdb.save_playbook_rev(
        conn, project_id=pid,
        steps=_steps(("pull", "Pull CRM export, wait 3h"), ("send", "Send")),
        base_rev=v1,
    )
    assert pdb.rebase_playbook_rev(conn, pid, mine) == {"refused": "current"}
    pdb.activate_playbook_rev(conn, pid, agent)

    result = pdb.rebase_playbook_rev(conn, pid, mine, created_by="leo")
    new = result["rev"]
    assert result == {
        "rev": new, "from_rev": mine, "base_rev": agent, "conflicts": [],
    }
    assert new > mine
    after = pdb.get_playbook(conn, pid, new)
    assert not after["active"] and after["base_rev"] == agent
    assert [s["title"] for s in after["steps"]] == [
        "Pull CRM export, wait 3h", "Send to the list",
    ]
    # The old proposal is left exactly as it was; only Discard removes it.
    old = pdb.get_playbook(conn, pid, mine)
    assert old["base_rev"] == v1 and old["steps"][1]["title"] == "Send"
    # Superseded (once active) revisions are history, not proposals.
    assert pdb.rebase_playbook_rev(conn, pid, v1) == {"refused": "active"}
    assert pdb.rebase_playbook_rev(conn, pid, 99) == {"refused": "not_found"}


def test_rebase_refuses_a_proposal_without_a_recorded_base(conn):
    pid = pdb.create_project(conn, name="Legacy", folders=["/tmp/legacy"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    legacy = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "B")))
    conn.execute("UPDATE project_playbook SET base_rev = NULL WHERE rev = ?", (legacy,))
    conn.commit()
    pdb.activate_playbook_rev(conn, pid, v1)
    assert pdb.rebase_playbook_rev(conn, pid, legacy) == {"refused": "no_base"}


def test_a_plan_written_from_nothing_records_base_zero_and_stays_a_proposal(conn):
    pid = pdb.create_project(conn, name="Root", folders=["/tmp/root"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    v2 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "B")), base_rev=None)
    assert pdb.get_playbook(conn, pid, v1)["base_rev"] == 0
    assert pdb.get_playbook(conn, pid, v2)["base_rev"] == 0
    pdb.activate_playbook_rev(conn, pid, v2)
    first = pdb.get_playbook(conn, pid, v1)
    assert first["base_rev"] == 0 and first["activated_at"] is None
    assert pdb.rebase_playbook_rev(conn, pid, v1) == {"refused": "no_base"}


def test_sibling_proposals_merge_from_their_shared_pending_parent(conn):
    pid = pdb.create_project(conn, name="Siblings", folders=["/tmp/siblings"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A"), ("b", "B")))
    pdb.activate_playbook_rev(conn, pid, v1)
    parent = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A1"), ("b", "B")))
    first = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("a", "A2"), ("b", "B")), base_rev=parent
    )
    second = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("a", "A1"), ("b", "B2")), base_rev=parent
    )
    pdb.activate_playbook_rev(conn, pid, first)
    # Both inherited A1 from the parent; only the active one changed it
    # further, so its A2 must survive the update.
    up = pdb.rebase_playbook_rev(conn, pid, second)
    assert up["conflicts"] == []
    assert [s["title"] for s in pdb.get_playbook(conn, pid, up["rev"])["steps"]] == ["A2", "B2"]


def test_rebasing_a_parent_keeps_its_children_on_a_true_base(conn):
    pid = pdb.create_project(conn, name="Chain", folders=["/tmp/chain"])
    v1 = pdb.save_playbook_rev(
        conn, project_id=pid,
        steps=_steps(("collect", "Collect"), ("review", "Review"), ("send", "Send")),
    )
    pdb.activate_playbook_rev(conn, pid, v1)
    parent = pdb.save_playbook_rev(
        conn, project_id=pid,
        steps=_steps(("collect", "Collect (3h)"), ("review", "Review"), ("send", "Send")),
    )
    child = pdb.save_playbook_rev(
        conn, project_id=pid,
        steps=_steps(("collect", "Collect (3h)"), ("review", "Review twice"), ("send", "Send")),
        base_rev=parent,
    )
    other = pdb.save_playbook_rev(
        conn, project_id=pid,
        steps=_steps(("collect", "Collect"), ("review", "Review"), ("send", "Send + CC")),
    )
    pdb.activate_playbook_rev(conn, pid, other)

    up = pdb.rebase_playbook_rev(conn, pid, parent)
    assert pdb.get_playbook(conn, pid, parent)["steps"][0]["title"] == "Collect (3h)"
    pdb.activate_playbook_rev(conn, pid, up["rev"])

    # The child carries the parent's change and its own, and still lacks
    # "Send + CC": it must not read as current just because its parent's
    # update is active now.
    done = pdb.rebase_playbook_rev(conn, pid, child)
    assert done["conflicts"] == [] and done["base_rev"] == up["rev"]
    titles = [s["title"] for s in pdb.get_playbook(conn, pid, done["rev"])["steps"]]
    assert titles == ["Collect (3h)", "Review twice", "Send + CC"]


def test_rebase_refuses_a_merge_that_leaves_no_steps(conn):
    pid = pdb.create_project(conn, name="Empty", folders=["/tmp/empty"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A"), ("b", "B")))
    pdb.activate_playbook_rev(conn, pid, v1)
    no_a = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("b", "B")))
    no_b = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    pdb.activate_playbook_rev(conn, pid, no_a)
    result = pdb.rebase_playbook_rev(conn, pid, no_b)
    assert result["refused"].startswith("invalid:") and "no steps" in result["refused"]
    assert pdb.get_playbook(conn, pid, no_b)["steps"][0]["key"] == "a"


def test_a_discarded_rev_number_is_never_reused(conn):
    pid = pdb.create_project(conn, name="Seq", folders=["/tmp/seq"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    pdb.activate_playbook_rev(conn, pid, v1)
    draft = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "B")))
    assert pdb.discard_playbook_rev(conn, pid, draft) is None
    again = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "C")))
    assert again > draft


def test_a_discard_survives_an_upgraded_counter(conn):
    pid = pdb.create_project(conn, name="Upgraded", folders=["/tmp/upgraded"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    pdb.activate_playbook_rev(conn, pid, v1)
    v2 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "B")))
    # A project from before the counter existed.
    conn.execute("UPDATE projects SET playbook_rev_seq = 0 WHERE id = ?", (pid,))
    conn.commit()
    assert pdb.discard_playbook_rev(conn, pid, v2) is None
    assert pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "C"))) > v2


def test_a_discarded_rev_is_hidden_but_stays_as_ancestry(conn):
    pid = pdb.create_project(conn, name="Hidden", folders=["/tmp/hidden"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    pdb.activate_playbook_rev(conn, pid, v1)
    parent = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "B")))
    child = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("a", "C")), base_rev=parent
    )
    assert pdb.discard_playbook_rev(conn, pid, parent) is None
    assert pdb.get_playbook(conn, pid, parent) is None
    assert parent not in {r["rev"] for r in pdb.list_playbook_revs(conn, pid)}
    assert pdb.activate_playbook_rev(conn, pid, parent) is False
    assert pdb.discard_playbook_rev(conn, pid, parent) == "not_found"
    assert pdb.rebase_playbook_rev(conn, pid, parent) == {"refused": "not_found"}
    assert pdb.get_playbook(conn, pid, child)["base_rev"] == parent
    assert pdb.list_discarded_playbook_ancestry(conn, pid) == [
        {"rev": parent, "base_rev": v1, "activated_at": None}
    ]


def test_updating_past_a_discarded_shared_base_keeps_the_active_edit(conn):
    pid = pdb.create_project(conn, name="Shared", folders=["/tmp/shared"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "Review"), ("b", "B")))
    pdb.activate_playbook_rev(conn, pid, v1)
    shared = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "Skip review"), ("b", "B")))
    child = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("a", "Skip review"), ("b", "B1")), base_rev=shared
    )
    sibling = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("a", "Review"), ("b", "B")), base_rev=shared
    )
    pdb.activate_playbook_rev(conn, pid, sibling)
    assert pdb.discard_playbook_rev(conn, pid, shared) is None
    up = pdb.rebase_playbook_rev(conn, pid, child)
    assert up["conflicts"] == []
    # The sibling's restored "Review" stays; the child only changed b.
    assert [s["title"] for s in pdb.get_playbook(conn, pid, up["rev"])["steps"]] == ["Review", "B1"]


def test_updating_past_a_discarded_step_falls_back_to_an_earlier_active_rev(conn):
    pid = pdb.create_project(conn, name="Roots", folders=["/tmp/roots"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A"), ("b", "B")))
    v2 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A2"), ("b", "B")), base_rev=None)
    pdb.activate_playbook_rev(conn, pid, v1)
    v3 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A"), ("b", "B3")), base_rev=v1)
    v4 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A"), ("b", "B4")), base_rev=v3)
    pdb.activate_playbook_rev(conn, pid, v2)
    assert pdb.discard_playbook_rev(conn, pid, v3) is None
    up = pdb.rebase_playbook_rev(conn, pid, v4)
    assert "refused" not in up, up
    assert [s["title"] for s in pdb.get_playbook(conn, pid, up["rev"])["steps"]] == ["A2", "B4"]


def test_a_proposal_beyond_a_discarded_once_active_rev_is_current(conn):
    pid = pdb.create_project(conn, name="Back", folders=["/tmp/back"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "A")))
    pdb.activate_playbook_rev(conn, pid, v1)
    v2 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "B")))
    pdb.activate_playbook_rev(conn, pid, v2)
    v3 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("a", "C")))
    pdb.activate_playbook_rev(conn, pid, v1)
    assert pdb.discard_playbook_rev(conn, pid, v2) is None
    assert pdb.rebase_playbook_rev(conn, pid, v3) == {"refused": "current"}


def test_a_proposal_the_active_rev_builds_on_has_nothing_to_update(conn):
    pid = pdb.create_project(conn, name="Included", folders=["/tmp/included"])
    v1 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("collect", "Collect")))
    v2 = pdb.save_playbook_rev(
        conn, project_id=pid, steps=_steps(("collect", "Collect"), ("send", "Send")), base_rev=v1
    )
    v3 = pdb.save_playbook_rev(conn, project_id=pid, steps=_steps(("collect", "Collect")), base_rev=v2)
    pdb.activate_playbook_rev(conn, pid, v3)
    assert pdb.discard_playbook_rev(conn, pid, v1) is None
    # v3 removed Send on purpose: updating v2 must not bring it back.
    assert pdb.rebase_playbook_rev(conn, pid, v2) == {"refused": "included"}
