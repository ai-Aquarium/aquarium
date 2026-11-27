"""/api/software-upgrade — Settings → Software upgrade (agent-home).

The owner and admins read, start and roll back (each with their own password); members
and viewers get 403 everywhere and the
root helper is never run for them. The status test runs the real
``deploy/aquarium.py upgrade status`` against an empty fake root; the others feed the
router helper answers. Also: release selection, release-note highlights, job shaping.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import software_upgrade_api as su

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "deploy" / "aquarium.py"

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)

READS = [("GET", "/api/software-upgrade", None), ("GET", "/api/software-upgrade/job", None),
         ("POST", "/api/software-upgrade/check", None)]
WRITES = [("POST", "/api/software-upgrade/start", {"version": "v1.1.0", "password": "pw"}),
          ("POST", "/api/software-upgrade/rollback", {"password": "pw"}),
          ("POST", "/api/software-upgrade/finish", None)]

STATUS = {
    "ok": True,
    "installed": {"layout": "release", "version": "v1.0.0", "commit": None, "branch": None,
                  "channel": "stable", "installed_at": "2026-10-01T10:00:00+00:00", "by": "Leo",
                  "label": "v1.0.0"},
    "job": {"id": "j1", "kind": "upgrade", "from": "v0.9.0", "to": "v1.0.0", "by": "Leo",
            "phase": "finished", "result": "failed", "alive": False, "backup": "/var/backups/x.gpg",
            "error": "build failed in /opt/aquarium/releases/.v1.0.0.partial/agent-home",
            "steps": [{"key": "download", "state": "done"}, {"key": "build", "state": "failed"}],
            "log": ["npm ERR! at /opt/aquarium/releases/v1.0.0/node_modules/x", "token=abc123 ok"]},
    "history": [{"id": "j1", "kind": "upgrade", "from": "v0.9.0", "to": "v1.0.0", "by": "Leo",
                 "result": "ok", "seconds": 61, "has_backup": True}],
    "releases_checked_at": "2026-11-05T01:00:00+00:00",
    "rollback": {"to": "v0.9.0"},
}
RELEASES = {"ok": True, "checked_at": "2026-11-05T02:00:00+00:00", "error": "", "releases": [
    {"tag": "v1.2.0-beta.1", "prerelease": True, "packaged": True, "notes": ""},
    {"tag": "v1.1.0", "name": "Spring", "prerelease": False, "packaged": True,
     "url": "https://github.com/ai-Aquarium/aquarium/releases/tag/v1.1.0",
     "notes": "## Highlights\n- **Faster chats** (#12)\n## Fixes\n- [Upload](https://x) no longer fails\n"},
    {"tag": "v1.0.1", "prerelease": False, "packaged": False, "notes": ""},
    {"tag": "v0.9.0", "prerelease": False, "packaged": True, "url": "javascript:alert(1)", "notes": ""},
    {"tag": "nightly", "prerelease": False, "packaged": True, "notes": ""},
]}


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"] or OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(web_server, "_comms_session_subject",
                        lambda request: state["as"].user_id if state["as"] else "")
    return state


@pytest.fixture
def helper(monkeypatch):
    """Records helper calls; answers from ``answers``."""
    calls = []
    answers = {"status": STATUS, "releases": RELEASES, "check": RELEASES,
               "start": {"ok": True, "started": True, "status": STATUS},
               "rollback": {"ok": True, "started": True, "status": STATUS}}
    monkeypatch.setattr(su, "work_in_progress", lambda: [])

    def fake(verb, payload=None, timeout=60):
        calls.append((verb, payload))
        return answers[verb]

    monkeypatch.setattr(su, "_call", fake)
    return SimpleNamespace(calls=calls, answers=answers)


@pytest.fixture
def password_ok(monkeypatch, acting):
    seen = []

    async def fake(request, password):
        seen.append(password)
        if password != "pw":
            from fastapi import HTTPException
            raise HTTPException(400, "That password is not right.")
        return acting["as"].display

    monkeypatch.setattr(su, "_confirm_password", fake)
    return seen


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _send(client, method, path, body):
    return client.request(method, path, json=body) if body else client.request(method, path)


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
@pytest.mark.parametrize("method,path,body", READS + WRITES, ids=[f"{m} {p}" for m, p, _ in READS + WRITES])
def test_members_and_viewers_get_nothing(client, acting, helper, password_ok, who, method, path, body):
    acting["as"] = who
    assert _send(client, method, path, body).status_code == 403
    assert helper.calls == [] and password_ok == []


def test_admin_upgrades_and_rolls_back_with_their_password(client, acting, helper, password_ok):
    acting["as"] = ADMIN
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "pw"})
    assert resp.status_code == 202 and resp.json()["started"] is True
    assert client.post("/api/software-upgrade/rollback", json={"password": "pw"}).status_code == 202
    assert password_ok == ["pw", "pw"]
    assert [c for c in helper.calls if c[0] != "status"] == [
        ("start", {"version": "v1.1.0", "by": "Ann"}), ("rollback", {"by": "Ann"})]


def test_admin_with_a_wrong_password_starts_nothing(client, acting, helper, password_ok):
    acting["as"] = ADMIN
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "nope"})
    assert resp.status_code == 400 and helper.calls == []


@pytest.mark.parametrize("method,path,body", READS, ids=[f"{m} {p}" for m, p, _ in READS])
def test_admin_reads(client, acting, helper, method, path, body):
    acting["as"] = ADMIN
    assert _send(client, method, path, body).status_code == 200


def test_status_has_no_paths_or_secrets(client, helper):
    body = client.get("/api/software-upgrade").json()
    text = json.dumps(body)
    assert "/opt/" not in text and "/var/" not in text and "abc123" not in text and "backup\"" not in text
    assert body["installed"] == {"version": "v1.0.0", "label": "v1.0.0", "commit": None, "kind": "release",
                                 "channel": "stable", "installed_at": "2026-10-01T10:00:00+00:00", "by": "Leo"}
    assert body["job"]["running"] is False and body["job"]["result"] == "failed"
    assert body["rollback_to"] == "v0.9.0" and body["checked_at"] == "2026-11-05T02:00:00+00:00"
    rel = body["releases"]
    # stable channel: no pre-release; release install: only packaged releases
    assert [r["tag"] for r in rel["newer"]] == ["v1.1.0"] and rel["latest"] == "v1.1.0"
    assert rel["older"] == []  # an older release is never offered
    assert rel["newer"][0]["highlights"] == [{"title": "Highlights", "items": ["Faster chats"]},
                                             {"title": "Fixes", "items": ["Upload no longer fails"]}]


def test_owner_starts_with_the_password(client, helper, password_ok):
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "pw"})
    assert resp.status_code == 202 and resp.json()["started"] is True
    assert [c for c in helper.calls if c[0] == "start"] == [("start", {"version": "v1.1.0", "by": "Owner"})]


@pytest.mark.parametrize("version", ["v1.0.0", "v0.9.0"])
def test_start_refuses_a_release_that_is_not_newer(client, helper, password_ok, version):
    resp = client.post("/api/software-upgrade/start", json={"version": version, "password": "pw"})
    assert resp.status_code == 400 and "newer" in resp.json()["detail"]
    assert [c for c in helper.calls if c[0] == "start"] == []


def test_checkout_start_uses_its_version_file_as_the_floor(client, helper, password_ok):
    helper.answers["status"] = {**STATUS, "installed": {
        **STATUS["installed"], "layout": "git", "version": None, "base_version": "v1.1.0"}}
    resp = client.post("/api/software-upgrade/start", json={"version": "v0.9.0", "password": "pw"})
    assert resp.status_code == 400
    view = client.get("/api/software-upgrade").json()["releases"]
    assert [r["tag"] for r in view["newer"]] == [] and view["older"] == []


def test_wrong_password_starts_nothing(client, helper, password_ok):
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "nope"})
    assert resp.status_code == 400 and "password" in resp.json()["detail"]
    assert helper.calls == []


def test_bad_version_is_refused_before_the_password(client, helper, password_ok):
    resp = client.post("/api/software-upgrade/start", json={"version": "latest && id", "password": "pw"})
    assert resp.status_code == 400 and password_ok == [] and helper.calls == []


def test_helper_refusal_is_shown_without_paths(client, helper, password_ok):
    helper.answers["start"] = {"ok": False, "error": "lock held by /run/aquarium.lock"}
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "pw"})
    assert resp.status_code == 400 and "/run" not in resp.json()["detail"]


def test_rollback_needs_the_password_too(client, helper, password_ok):
    assert client.post("/api/software-upgrade/rollback", json={}).status_code == 422
    assert client.post("/api/software-upgrade/rollback", json={"password": "pw"}).status_code == 202
    assert helper.calls == [("rollback", {"by": "Owner"})]


def test_without_the_helper_the_page_says_unavailable(client, monkeypatch):
    monkeypatch.setattr(su, "_helper_argv", lambda verb: ["/nonexistent/aquarium", verb])
    assert client.get("/api/software-upgrade").json()["available"] is False
    monkeypatch.setattr(su, "_helper_argv", lambda verb: ["/bin/false"])  # sudo refused
    assert client.get("/api/software-upgrade").json()["available"] is False


def test_real_helper_status_on_an_empty_box(client, tmp_path, monkeypatch):
    monkeypatch.setenv("AQUARIUM_TEST_PREFIX", str(tmp_path))
    monkeypatch.setattr(su, "_helper_argv", lambda verb: [sys.executable, str(CLI), "upgrade", verb])
    body = client.get("/api/software-upgrade/job").json()
    assert body["available"] is True and body["job"] is None and body["history"] == []
    assert str(tmp_path) not in json.dumps(body)


PREFLIGHT = {"version": "v1.1.0", "checks": [
    {"key": "disk", "status": "ok", "message": "40 GB of disk space is free."},
    {"key": "backup", "status": "fail", "message": "The backup folder /var/backups/aquarium can't be written to."},
    {"key": "services", "status": "ok", "message": "All services are running and answer."},
    {"key": "release", "status": "ok", "message": "v1.1.0 can be downloaded and its signature is valid."}]}


def test_check_with_a_version_returns_the_preflight(client, helper, monkeypatch):
    helper.answers["check"] = {**RELEASES, "preflight": PREFLIGHT}
    monkeypatch.setattr(su, "work_in_progress", lambda: ["1 project run is in progress"])
    body = client.post("/api/software-upgrade/check", json={"version": "v1.1.0"}).json()
    assert ("check", {"version": "v1.1.0"}) in helper.calls
    pf = body["preflight"]
    assert pf["ok"] is False and pf["busy"] == ["1 project run is in progress"]
    assert [c["key"] for c in pf["checks"] if not c["ok"]] == ["backup"]
    assert "/var" not in json.dumps(pf)


def test_check_without_a_version_only_refreshes(client, helper):
    body = client.post("/api/software-upgrade/check").json()
    assert ("check", None) in helper.calls and "preflight" not in body


def test_check_helper_timeout_says_so_instead_of_empty_rows(client, helper):
    # The helper's 240 s cap hit mid-check used to leave the page showing four
    # eternal "checking…" rows — the error was swallowed.
    helper.answers["check"] = {"ok": False, "error": "The server took too long to answer. Try again."}
    body = client.post("/api/software-upgrade/check", json={"version": "v1.1.0"}).json()
    pf = body["preflight"]
    assert pf["error"] == "The server took too long to answer. Try again."
    assert pf["checks"] == [] and pf["ok"] is False


def test_check_view_passes_live_progress_rows_through_status(client, helper):
    helper.answers["status"] = {**STATUS, "check": {
        "version": "v1.1.0", "started": "2026-11-05T08:00:00", "done": False,
        "checks": [
            {"key": "disk", "status": "ok", "message": "40 GB of disk space is free."},
            {"key": "services", "status": "running", "message": "Asking every service."},
            {"key": "bogus", "status": "ok", "message": "not a real check"},
            {"key": "release", "status": "weird", "message": "not a known state"},
        ]}}
    body = client.get("/api/software-upgrade/job").json()
    check = body["check"]
    assert check["version"] == "v1.1.0" and check["done"] is False
    assert check["checks"] == [
        {"key": "disk", "running": False, "ok": True, "message": "40 GB of disk space is free."},
        {"key": "services", "running": True, "ok": False, "message": "Asking every service."},
        {"key": "release", "running": False, "ok": False, "message": "not a known state"},
    ]


def test_preflight_missing_a_check_is_not_ok():
    pf = su.preflight_view({"checks": PREFLIGHT["checks"][:1]}, [])
    assert pf["ok"] is False


def test_start_while_work_runs_needs_a_confirm(client, helper, password_ok, monkeypatch):
    monkeypatch.setattr(su, "work_in_progress", lambda: ["2 chat replies are being written"])
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "pw"})
    assert resp.status_code == 409 and "2 chat replies" in resp.json()["detail"]
    assert [c for c in helper.calls if c[0] == "start"] == []
    resp = client.post("/api/software-upgrade/start",
                       json={"version": "v1.1.0", "password": "pw", "confirm_busy": True})
    assert resp.status_code == 202


def test_finish_try_again_starts_the_finish_job(client, helper):
    resp = client.post("/api/software-upgrade/finish")
    assert resp.status_code == 202
    assert helper.calls == [("start", {"finish": True, "by": "Owner"})]


def test_finish_failure_and_kind_are_shown():
    view = su.status_view({**STATUS, "job": {**STATUS["job"], "kind": "finish"},
                           "finish": {"failed": True, "error": "visudo refused /etc/sudoers.d/x", "at": "t"}})
    assert view["job"]["kind"] == "finish"
    assert view["finish"] == {"failed": True, "error": "visudo refused …", "at": "t"}


def test_work_in_progress_counts_live_chat_turns(monkeypatch):
    from hermes_cli import web_server as ws

    monkeypatch.setattr(ws, "_CHAT_RUNS", {"a": {"done": False}, "b": {"done": True},
                                           "c": {"done": False, "next_run_id": "d"}})
    assert "1 chat reply is being written" in su.work_in_progress()


def test_work_in_progress_counts_every_profiles_gateway(monkeypatch, tmp_path):
    import json as _json

    from hermes_cli import web_server as ws

    monkeypatch.setattr(ws, "_CHAT_RUNS", {})
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for home, agents in ((tmp_path, 0), (tmp_path / "profiles/sales", 2), (tmp_path / "profiles/ops", 1)):
        home.mkdir(parents=True, exist_ok=True)
        (home / "gateway_state.json").write_text(_json.dumps({"gateway_state": "running", "active_agents": agents}))
    (tmp_path / "profiles/idle").mkdir()
    monkeypatch.setattr(su, "_gateway_running", lambda home, rt: home.name != "ops")
    assert "2 messaging conversations are mid-turn" in su.work_in_progress()


# --------------------------------------------------------------------------- password re-check


def _request(session):
    return SimpleNamespace(state=SimpleNamespace(session=session), headers={},
                           client=SimpleNamespace(host="10.0.0.9"))


class _Provider:
    supports_password = True

    def __init__(self, user_id="root"):
        self.user_id, self.calls = user_id, []

    def complete_password_login(self, *, username, password):
        from hermes_cli.dashboard_auth.base import InvalidCredentialsError
        self.calls.append(username)
        if password != "right":
            raise InvalidCredentialsError("no")
        return SimpleNamespace(user_id=self.user_id)


@pytest.fixture
def provider(monkeypatch, acting):
    from hermes_cli import dashboard_auth
    from hermes_cli.dashboard_auth import routes

    p = _Provider()
    monkeypatch.setattr(dashboard_auth, "get_provider", lambda name: p if name == "supabase" else None)
    monkeypatch.setattr(routes, "_pw_attempts", type(routes._pw_attempts)(routes._pw_attempts.default_factory))
    return p


SESSION = SimpleNamespace(user_id="root", email="owner@example.com", provider="supabase", display_name="O")


def test_confirm_password_checks_the_signed_in_users_password(provider):
    import asyncio

    assert asyncio.run(su._confirm_password(_request(SESSION), "right")) == "Owner"
    assert provider.calls == ["owner@example.com"]
    with pytest.raises(Exception) as exc:
        asyncio.run(su._confirm_password(_request(SESSION), "wrong"))
    assert exc.value.status_code == 400


def test_confirm_password_refuses_someone_elses_password(provider):
    import asyncio

    provider.user_id = "someone-else"
    with pytest.raises(Exception) as exc:
        asyncio.run(su._confirm_password(_request(SESSION), "right"))
    assert exc.value.status_code == 400


def test_confirm_password_needs_a_password_login(provider):
    import asyncio

    for session in (None, SimpleNamespace(**{**vars(SESSION), "provider": "github"})):
        with pytest.raises(Exception) as exc:
            asyncio.run(su._confirm_password(_request(session), "right"))
        assert exc.value.status_code == 403


def test_confirm_password_is_rate_limited(provider):
    import asyncio

    codes = []
    for _ in range(12):
        try:
            asyncio.run(su._confirm_password(_request(SESSION), "wrong"))
        except Exception as exc:  # noqa: BLE001
            codes.append(exc.status_code)
    assert codes[:10] == [400] * 10 and codes[10:] == [429, 429]


# --------------------------------------------------------------------------- selection + shaping


def test_version_order():
    tags = ["v1.10.0", "v1.2.0", "v1.2.0-beta.2", "v1.2.0-beta.10", "v1.2.0-rc.1", "v2.0.0"]
    assert sorted(tags, key=su.version_key) == [
        "v1.2.0-beta.2", "v1.2.0-beta.10", "v1.2.0-rc.1", "v1.2.0", "v1.10.0", "v2.0.0"]
    assert su.version_key("1.2.3") is None and su.version_key("v1.2") is None


def test_beta_channel_and_checkout_without_a_version():
    rels = RELEASES["releases"]
    beta = su.select_releases(rels, "v1.0.0", "beta")
    assert [r["tag"] for r in beta["newer"]] == ["v1.2.0-beta.1", "v1.1.0", "v1.0.1"]
    assert beta["latest"] == "v1.2.0-beta.1"
    # a develop checkout: its VERSION file is the floor, so older stable releases are never offered
    branch = su.select_releases(rels, None, "stable", base="v1.0.0")
    assert [r["tag"] for r in branch["newer"]] == ["v1.1.0", "v1.0.1"] and branch["older"] == []
    ahead = su.select_releases(rels, None, "stable", base="v1.2.0-rc.2")
    assert ahead["newer"] == [] and ahead["latest"] is None
    unknown = su.select_releases(rels, None, "stable")
    assert unknown["newer"] == [] and unknown["latest"] is None
    newest = su.select_releases(rels, "v1.1.0", "stable")
    assert newest["newer"] == [] and newest["latest"] is None


def test_job_steps_and_running_state():
    job = su._job_view({"id": "x", "phase": "running", "alive": True, "kind": "rollback",
                        "steps": [{"key": "backup", "state": "done"}, {"key": "download", "state": "running"},
                                  "junk"]})
    assert job["running"] is True and job["kind"] == "rollback"
    assert [(s["key"], s["state"]) for s in job["steps"]] == [("backup", "done"), ("download", "running")]
    died = su._job_view({"phase": "finished", "result": "interrupted", "alive": False})
    assert died["running"] is False and died["result"] == "interrupted"


def test_background_base_backup_reaches_the_page_without_paths():
    job = su._job_view({"id": "j", "phase": "finished", "result": "ok", "alive": False,
                        "backup_since": "2026-11-05T03:30:00Z", "base_backup": True})
    assert job["backup_since"] == "2026-11-05T03:30:00Z" and job["base_started"] is True
    plain = su._job_view({"id": "j", "phase": "finished", "result": "ok", "alive": False})
    assert plain["backup_since"] is None and plain["base_started"] is False
    view = su.status_view({**STATUS, "base_backup": {
        "state": "failed", "after_job": "j", "finished": "2026-11-05T10:00:00Z",
        "error": "gpg failed writing /var/backups/aquarium/x.part"}})
    assert view["base_job"]["state"] == "failed" and view["base_job"]["after_job"] == "j"
    assert "/var/backups" not in view["base_job"]["error"]
    assert su.status_view({**STATUS, "base_backup": {"state": "weird"}})["base_job"] is None
    assert su.status_view(STATUS)["base_job"] is None


def test_scrub():
    assert su.scrub("cp /opt/data/hermes-agent/x.py to /tmp/y failed") == "cp … to … failed"
    assert su.scrub("password=hunter2 and SECRET=abc") == "password=… and SECRET=…"
    assert su.scrub("https://github.com/ai-Aquarium/aquarium/releases ok") == "https://github.com/ai-Aquarium/aquarium/releases ok"


def test_checkout_shows_branch_commits_not_installed():
    raw = {**STATUS, "installed": {**STATUS["installed"], "layout": "git", "version": None,
                                   "commit": "7b09787fc", "branch": "develop", "label": "develop@7b09787fc"}}
    rel = {"releases": [], "checkout": {
        "commit": "7b09787fc" + "0" * 31, "branch": "develop", "behind": 4, "tip": "5188a9b00",
        "commits": [{"sha": "5188a9b00", "title": "fix in /opt/data/hermes-agent/x.py token=abc", "date": "d"},
                    {"sha": "not-a-sha", "title": "t"}, "junk"],
        "error": ""}}
    view = su.status_view(raw, rel)
    co = view["checkout"]
    assert co["branch"] == "develop" and co["behind"] == 4 and co["commit"] == "7b09787fc" and co["tip"] == "5188a9b00"
    assert [c["sha"] for c in co["commits"]] == ["5188a9b00", None]
    assert "/opt" not in co["commits"][0]["title"] and "abc" not in co["commits"][0]["title"]
    assert co["error"] is None and view["releases"]["latest"] is None
    # a release install never carries a branch comparison
    assert su.status_view(STATUS, rel)["checkout"] is None
    # bad counts are unknown, not zero
    assert su.status_view(raw, {"checkout": {"behind": True}})["checkout"]["behind"] is None
