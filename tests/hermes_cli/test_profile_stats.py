"""Agent Profiles stats (``hermes_cli.profile_stats``) and creature metadata,
against a temp HERMES_HOME with real SQLite stores."""

import json
import sqlite3
import time

import pytest

from hermes_cli import aquarium_creatures, profile_stats, profiles as profiles_mod

NOW = float(int(time.time()))
DAY = 86400


def _sessions(home, rows):
    from hermes_state import SessionDB

    home.mkdir(parents=True, exist_ok=True)
    db = SessionDB(db_path=home / "state.db")
    for i, (age_days, source, tokens, cost, messages) in enumerate(rows):
        sid = f"s{i}"
        db.create_session(sid, source)
        db.update_token_counts(sid, input_tokens=tokens // 2, output_tokens=tokens - tokens // 2,
                               estimated_cost_usd=cost)
        db._conn.execute(
            "UPDATE sessions SET started_at = ?, ended_at = ?, message_count = ? WHERE id = ?",
            (NOW - age_days * DAY, NOW - age_days * DAY + 60, messages, sid),
        )
        db._conn.commit()
    db.close()


def _ledger(home, rows):
    from hermes_cli import skill_ledger

    home.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(home / "skill_ledger.db") as conn:
        conn.executescript(skill_ledger._SCHEMA)
        for age_days, skill, profile in rows:
            conn.execute(
                "INSERT INTO skill_events (ts, skill_name, trigger, profile) VALUES (?, ?, 'tool', ?)",
                (NOW - age_days * DAY, skill, profile),
            )


@pytest.fixture
def homes(_isolate_hermes_home):
    from hermes_constants import get_hermes_home

    root = get_hermes_home()
    root.mkdir(parents=True, exist_ok=True)
    coder = root / "profiles" / "coder"
    fresh = root / "profiles" / "fresh"
    coder.mkdir(parents=True)
    fresh.mkdir(parents=True)
    return root, coder, fresh


def _stores(root, coder):
    from hermes_cli import kanban_db, projects_db

    _sessions(root, [(1, "web", 1000, 0.5, 4), (3, "telegram", 500, 0.25, 2), (40, "web", 9999, 9.0, 9)])
    _sessions(coder, [(0, "web", 200, None, 1)])
    _ledger(root, [(1, "web-search", None), (2, "web-search", "default"), (2, "summarise", "default"),
                   (1, "github-pr", "coder"), (50, "old-skill", "default")])
    _ledger(coder, [(1, "run-tests", None), (1, "run-tests", "coder")])

    with projects_db.connect_closing():
        pass
    with sqlite3.connect(projects_db.projects_db_path()) as conn:
        for i, (pid, prof, status, age) in enumerate([
            ("p1", "default", "done", 2), ("p2", "default", "done", 5), ("p1", "default", "done", 1),
            ("p3", "default", "done", 60), ("p4", "coder", "running", 0), ("p5", "coder", "waiting", 0),
        ]):
            conn.execute(
                "INSERT INTO project_runs (id, project_id, run_no, trigger, profile, status, started_at, ended_at) "
                "VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)",
                (f"r{i}", pid, i, prof, status, int(NOW - age * DAY), int(NOW - age * DAY) if status == "done" else None),
            )

    with kanban_db.connect_closing(board=kanban_db.DEFAULT_BOARD):
        pass
    with sqlite3.connect(kanban_db.kanban_db_path(board=kanban_db.DEFAULT_BOARD)) as conn:
        for tid, title, assignee, status, vis in [
            ("t1", "Fix CI on PR #1", "coder", "running", "shared"),
            ("t2", "Secret thing", "default", "running", "private:u1"),
            ("t3", "Waiting on a key", "coder", "blocked", "shared"),
        ]:
            conn.execute(
                "INSERT INTO tasks (id, title, assignee, status, visibility, created_at, started_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (tid, title, assignee, status, vis, int(NOW), int(NOW)),
            )
        conn.execute(
            "INSERT INTO task_approvals (task_id, approval_key, label, requested_at) VALUES ('t1', 'k', 'Ship?', ?)",
            (int(NOW),),
        )

    (coder / "gateway_state.json").write_text(json.dumps({
        "gateway_state": "running",
        "platforms": {"telegram": {"state": "connected"}, "slack": {"state": "error"}},
    }))


def test_collect_reads_every_store(homes):
    root, coder, fresh = homes
    _stores(root, coder)
    out = profile_stats.collect(
        [("default", root), ("coder", coder), ("fresh", fresh)], days=30, now=NOW,
    )
    d, c, f = (out["profiles"][n] for n in ("default", "coder", "fresh"))

    assert d["tokens"] == 1500 and d["cost_usd"] == pytest.approx(0.75)
    assert d["chats"] == 2 and d["messages"] == 6
    assert d["chat_sources"] == ["telegram", "web"]
    assert sum(d["tokens_by_day"]) == 1500 and d["tokens_by_day"][-2] == 1000
    assert d["skills_used"] == 2
    assert d["top_skills"][0] == {"name": "web-search", "uses": 2}
    assert d["projects_done"] == 2 and d["projects_running"] == 0
    # A private task is reported as working without leaking its title.
    assert d["current_task"] == {"kind": "task", "title": None, "started_at": int(NOW)}

    assert c["skills_used"] == 2 and {s["name"] for s in c["top_skills"]} == {"run-tests", "github-pr"}
    assert c["projects_running"] == 2
    assert c["current_task"]["title"] == "Fix CI on PR #1"
    assert c["tasks_running"] == 1
    assert c["needs_you"] == 3  # blocked task + pending approval + waiting project run
    assert c["channels"] == ["telegram"]

    assert f == {**profile_stats.empty_stats()}
    assert out["totals"]["tokens"] == 1700
    assert out["totals"]["projects_done"] == 2
    assert out["totals"]["working"] == 2
    assert "path" not in json.dumps(out) and str(root) not in json.dumps(out)


def test_collect_tolerates_missing_and_broken_stores(homes):
    root, coder, fresh = homes
    (fresh / "state.db").write_text("not a database")
    (fresh / "gateway_state.json").write_text("{")
    out = profile_stats.collect([("fresh", fresh)], days=30, now=NOW)
    assert out["profiles"]["fresh"]["last_active_at"] is None
    assert out["profiles"]["fresh"]["tokens"] == 0


def test_live_chat_counts_as_working(homes):
    root, _, _ = homes
    out = profile_stats.collect([("default", root)], live_chats=[{"profile": None, "started_at": NOW - 5}], now=NOW)
    assert out["profiles"]["default"]["current_task"]["kind"] == "chat"
    assert out["totals"]["working"] == 1


def test_profile_creature_is_stable_and_valid():
    picks = {aquarium_creatures.profile_creature(f"p{i}") for i in range(200)}
    assert picks <= set(aquarium_creatures.CREATURES)
    assert len(picks) > 20
    assert aquarium_creatures.profile_creature("coder") == aquarium_creatures.profile_creature("coder")


def test_creature_meta_round_trip_and_validation(homes):
    _, coder, _ = homes
    profiles_mod.write_profile_meta(coder, description="Writes code")
    assert profiles_mod.read_profile_meta(coder)["creature"] == ""
    profiles_mod.write_profile_meta(coder, creature="narwhal")
    meta = profiles_mod.read_profile_meta(coder)
    assert meta["creature"] == "narwhal" and meta["description"] == "Writes code"
    with pytest.raises(ValueError):
        profiles_mod.write_profile_meta(coder, creature="kraken")
    assert profiles_mod.read_profile_meta(coder)["creature"] == "narwhal"


class TestEndpoints:
    @pytest.fixture(autouse=True)
    def _setup(self, monkeypatch, homes):
        from starlette.testclient import TestClient
        import hermes_state
        from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

        root, coder, _ = homes
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", root / "state.db")
        self.root, self.coder = root, coder
        self.client = TestClient(app)
        self.client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    def test_list_carries_creature(self):
        profiles = {p["name"]: p for p in self.client.get("/api/profiles").json()["profiles"]}
        assert profiles["coder"]["creature"] == aquarium_creatures.profile_creature("coder")

    def test_put_creature_validates_and_persists(self):
        bad = self.client.put("/api/profiles/coder/creature", json={"creature": "kraken"})
        assert bad.status_code == 400
        assert self.client.put("/api/profiles/nope/creature", json={"creature": "crab"}).status_code == 404
        ok = self.client.put("/api/profiles/coder/creature", json={"creature": "crab"})
        assert ok.status_code == 200 and ok.json()["creature"] == "crab"
        profiles = {p["name"]: p for p in self.client.get("/api/profiles").json()["profiles"]}
        assert profiles["coder"]["creature"] == "crab"

    def test_stats_endpoint_fresh_install(self):
        resp = self.client.get("/api/profiles/stats?days=7")
        assert resp.status_code == 200
        body = resp.json()
        assert body["days"] == 7
        assert set(body["profiles"]) >= {"default", "coder", "fresh"}
        assert body["profiles"]["fresh"]["last_active_at"] is None
        assert str(self.root) not in resp.text

    def test_stats_endpoint_real_usage(self):
        _sessions(self.coder, [(0, "web", 300, 0.1, 2)])
        body = self.client.get("/api/profiles/stats").json()
        assert body["days"] == 30
        assert body["profiles"]["coder"]["tokens"] == 300
        assert body["profiles"]["coder"]["last_active_at"] is not None
