"""``POST /auth/refresh`` — rotating a session for a server-side token holder.

agent-home keeps the dashboard tokens in its own session cookie and renews
them here before the access token lapses (``agent-home/src/lib/auth/renew.ts``).
Driven through the real app and the real ``gated_auth_middleware``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider


@pytest.fixture
def stub():
    clear_providers()
    provider = StubAuthProvider()
    register_provider(provider)
    prev_required = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = True
    yield provider
    clear_providers()
    web_server.app.state.auth_required = prev_required


def _login(provider: StubAuthProvider):
    provider._state_to_verifier["s"] = "v"
    return provider.complete_login(code="stub_code", state="s", code_verifier="v", redirect_uri="x")


def _set_cookies(resp) -> dict[str, str]:
    out = {}
    for raw in resp.headers.get_list("set-cookie"):
        name, _, rest = raw.partition("=")
        out[name] = raw
    return out


def _value(raw: str) -> str:
    return raw.split("=", 1)[1].split(";", 1)[0].strip('"')


def test_refresh_rotates_the_session_like_a_login(stub):
    session = _login(stub)
    client = TestClient(web_server.app, base_url="http://127.0.0.1")

    resp = client.post("/auth/refresh", headers={"cookie": f"hermes_session_rt={session.refresh_token}"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True and body["expires_in"] >= 3000
    cookies = _set_cookies(resp)
    at, rt = _value(cookies["hermes_session_at"]), _value(cookies["hermes_session_rt"])
    assert "Max-Age=" in cookies["hermes_session_at"]
    assert stub.verify_session(access_token=at) is not None
    assert rt
    # The rotated access token authenticates a gated API call on its own.
    me = TestClient(web_server.app, base_url="http://127.0.0.1").get(
        "/api/auth/me", headers={"cookie": f"hermes_session_at={at}"}
    )
    assert me.status_code == 200, me.text


@pytest.mark.parametrize("cookie", ["", "hermes_session_rt=not-a-real-token"])
def test_refresh_without_a_live_refresh_token_is_401(stub, cookie):
    client = TestClient(web_server.app, base_url="http://127.0.0.1")
    resp = client.post("/auth/refresh", headers={"cookie": cookie} if cookie else {})
    assert resp.status_code == 401
    assert "hermes_session_at" not in {k for k, v in _set_cookies(resp).items() if _value(v)}
