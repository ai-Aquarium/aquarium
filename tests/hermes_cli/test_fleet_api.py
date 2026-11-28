"""/api/fleet — Settings → Fleet (agent-home, owner only).

The owner reads the fleet and starts layout switches (with their own password); admins,
members and viewers get 403 everywhere and the root helper is never run for them. The
status test runs the real ``deploy/aquarium.py fleet status`` against an empty fake root
(no fleet.json → ``available: false``); the others feed the router helper answers.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import fleet_api as fl

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "deploy" / "aquarium.py"

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)

ROUTES = [("GET", "/api/fleet", None), ("GET", "/api/fleet/available", None),
          ("GET", "/api/fleet/job", None),
          ("POST", "/api/fleet/switch", {"box": "hsd", "layout": "git", "password": "pw"})]

STATUS = {
    "ok": True, "available": True,
    "boxes": [
        {"name": "leo", "label": "Leo's box", "self": True, "reachable": True,
         "installed": {"layout": "git", "version": None, "label": "git-a1b2c3d",
                       "commit": "a1b2c3d", "channel": None, "installed_at": None},
         "job": None, "switch": None, "error": ""},
        {"name": "hsd", "label": "HSD", "self": False, "reachable": True,
         "installed": {"layout": "release", "version": "v1.0.0", "label": "v1.0.0",
                       "commit": None, "channel": "stable",
                       "installed_at": "2026-11-01T10:00:00+00:00"},
         "job": {"id": "j9", "phase": "running", "to": "v1.1.0", "seconds": None},
         "switch": {"id": "s1", "to": "git", "by": "Leo", "started": "2026-11-27T12:00:00Z",
                    "finished": None, "state": "running", "active": "active",
                    "log": ["==> building in /opt/data/hermes-agent", "token=abc123 ok"]},
         "error": ""},
        {"name": "down", "label": "Old box", "self": False, "reachable": False,
         "installed": None, "job": None, "switch": None,
         "error": "ssh: connect to host 10.0.0.9 port 22: timed out"},
    ],
}
JOBS = {"ok": True, "available": True, "jobs": {
    "hsd": {"id": "s1", "to": "git", "by": "Leo", "started": "2026-11-27T12:00:00Z",
            "finished": "2026-11-27T12:01:00Z", "state": "ok", "active": "inactive", "log": []}}}


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
    answers = {"probe": {"ok": True, "available": True}, "status": STATUS, "job": JOBS,
               "switch": {"ok": True, "started": True, "box": "hsd", "layout": "git",
                          "job": JOBS["jobs"]["hsd"]}}

    def fake(verb, payload=None, timeout=60):
        calls.append((verb, payload))
        return answers[verb]

    monkeypatch.setattr(fl, "_call", fake)
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

    monkeypatch.setattr(fl, "_confirm_password", fake)
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


@pytest.mark.parametrize("who", [ADMIN, MEMBER, VIEWER], ids=["admin", "member", "viewer"])
@pytest.mark.parametrize("method,path,body", ROUTES, ids=[f"{m} {p}" for m, p, _ in ROUTES])
def test_only_the_owner_gets_anything(client, acting, helper, password_ok, who, method, path, body):
    acting["as"] = who
    assert _send(client, method, path, body).status_code == 403
    assert helper.calls == [] and password_ok == []


@pytest.mark.parametrize("method,path,body", ROUTES[:3], ids=[f"{m} {p}" for m, p, _ in ROUTES[:3]])
def test_owner_reads(client, acting, helper, method, path, body):
    assert _send(client, method, path, body).status_code == 200


def test_status_rows_and_scrubbing(client, helper):
    body = client.get("/api/fleet").json()
    assert body["available"] is True and len(body["boxes"]) == 3
    leo, hsd, down = body["boxes"]
    assert leo["self"] is True and leo["installed"]["layout"] == "git"
    assert hsd["installed"]["layout"] == "release" and hsd["installed"]["channel"] == "stable"
    assert hsd["job"]["phase"] == "running" and hsd["switch"]["state"] == "running"
    assert down["reachable"] is False and down["installed"] is None
    text = json.dumps(body)
    assert "/opt/" not in text and "abc123" not in text


def test_switch_rechecks_the_password(client, helper, password_ok):
    resp = client.post("/api/fleet/switch", json={"box": "hsd", "layout": "git", "password": "pw"})
    assert resp.status_code == 202 and resp.json()["started"] is True
    assert password_ok == ["pw"]
    assert helper.calls == [("switch", {"box": "hsd", "layout": "git", "by": "Owner"})]
    assert resp.json()["job"]["state"] == "ok"


def test_switch_with_a_wrong_password_starts_nothing(client, helper, password_ok):
    resp = client.post("/api/fleet/switch", json={"box": "hsd", "layout": "git", "password": "nope"})
    assert resp.status_code == 400 and helper.calls == []


@pytest.mark.parametrize("body", [{"box": "hsd", "layout": "sideways", "password": "pw"},
                                  {"box": "BAD BOX", "layout": "git", "password": "pw"}],
                         ids=["bad layout", "bad box"])
def test_switch_validation_precedes_the_password(client, helper, password_ok, body):
    resp = client.post("/api/fleet/switch", json=body)
    assert resp.status_code == 400 and password_ok == [] and helper.calls == []


def test_helper_refusal_is_shown_without_paths(client, helper, password_ok):
    helper.answers["switch"] = {"ok": False, "error": "a switch is already running on /var/lib/aquarium/x"}
    resp = client.post("/api/fleet/switch", json={"box": "hsd", "layout": "git", "password": "pw"})
    assert resp.status_code == 400 and "/var" not in resp.json()["detail"]


def test_unavailable_when_the_fleet_is_not_set_up(client, helper):
    helper.answers["probe"] = {"ok": True, "available": False}
    helper.answers["status"] = {"ok": True, "available": False, "boxes": []}
    assert client.get("/api/fleet/available").json() == {"available": False}
    body = client.get("/api/fleet").json()
    assert body["available"] is False and "boxes" not in body


def test_without_the_helper_the_page_says_unavailable(client, monkeypatch):
    monkeypatch.setattr(fl, "_helper_argv", lambda verb: ["/nonexistent/aquarium", verb])
    assert client.get("/api/fleet").json()["available"] is False
    monkeypatch.setattr(fl, "_helper_argv", lambda verb: ["/bin/false"])  # sudo refused
    assert client.get("/api/fleet").json()["available"] is False


def test_real_helper_on_an_empty_box(client, tmp_path, monkeypatch):
    monkeypatch.setenv("AQUARIUM_TEST_PREFIX", str(tmp_path))
    monkeypatch.setattr(fl, "_helper_argv", lambda verb: [sys.executable, str(CLI), "fleet", verb])
    assert client.get("/api/fleet/available").json() == {"available": False}
    body = client.get("/api/fleet").json()
    assert body["available"] is False and str(tmp_path) not in json.dumps(body)
