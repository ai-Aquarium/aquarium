"""A served profile with no app datastore, on real Postgres.

A box may serve single-user profiles beside multi-user ones: ``coder`` here has
no ``datastore.supabase_app.dsn``, so it holds no ``principals`` rows. Every
cross-profile read (Sources, the profile switcher / chat picker, "Why this
profile?", claims, routing, the account-verb gate) must read it as "not
enrolled" instead of failing for everyone; a profile whose DSN *is* set but
cannot be reached must still fail. Real profiles over a tmp hermes root, the
real box registry and the real route table (see ``test_source_registry_e2e``).
"""

from __future__ import annotations

import asyncio

import pytest
import yaml

from hermes_cli import source_registry as registry
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401 — pytest fixtures
from tests.hermes_cli.test_source_registry_e2e import (  # noqa: F401 — pytest fixture
    MAILBOX,
    _box,
    _client,
    _session_as,
    box,
)

UNREACHABLE = "postgresql://postgres:nope@127.0.0.1:1/nope"


def _add_profile(box, name: str, config: dict):
    from hermes_cli.profile_registry import get_profile_registry
    from hermes_cli.profiles import create_profile

    create_profile(name, no_alias=True, verify_datastore=False)
    home = next(e.hermes_home for e in get_profile_registry() if e.name == name)
    (home / "config.yaml").write_text(yaml.safe_dump(config))
    box["homes"][name] = home
    return home


@pytest.fixture
def with_coder(box):
    _add_profile(box, "coder", {"model": {"default": "stub"}})
    return box


def test_sources_switcher_and_why_this_profile_skip_an_unconfigured_profile(
    with_coder, monkeypatch
):
    from hermes_cli.console_scope import enrolled_profiles, principal_store_factory

    async def setup(c):
        src = await registry.register_source(c, channel="email", address=MAILBOX,
                                             owner_user_id="john")
        await registry.set_route(c, source_id=src.source_id, profile_slug="cfo",
                                 enabled=True, actor_user_id="john")
        return src.source_id

    source_id = _box(with_coder["dsn"], setup)

    # Settings → Sources: the production 500.
    _session_as(monkeypatch, "john")
    john = _client("john")
    r = john.get("/api/sources")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["profiles"] == ["default", "cfo", "cmo"]
    assert "coder" not in body["profile_roles"]
    assert [s["source_id"] for s in body["sources"]] == [source_id]

    # The profile switcher / chat picker.
    r = john.get("/api/auth/my-profiles")
    assert r.status_code == 200, r.text
    assert [p["name"] for p in r.json()["profiles"]] == ["default", "cfo", "cmo"]

    # "Why this profile?" (routing decisions), the caller's and the box admin's.
    assert john.get("/api/sources/decisions").status_code == 200
    _session_as(monkeypatch, "leo")
    leo = _client("leo")
    assert leo.get("/api/sources/decisions", params={"all": 1}).status_code == 200
    assert leo.get("/api/sources", params={"all": 1}).json()["is_box_admin"] is True
    r = leo.get("/api/comms/people/john/profiles")
    assert r.status_code == 200, r.text
    assert "coder" not in [p["name"] for p in r.json()["profiles"]]

    # A claim conflict names the owner from their enrolments.
    _session_as(monkeypatch, "mary")
    r = _client("mary").post("/api/sources", json={"channel": "email", "address": MAILBOX})
    assert r.status_code == 409, r.text

    # Routing to it is refused as "not a member" rather than erroring.
    assert asyncio.run(registry.is_active_in_profile("john", "coder")) is False

    async def route(c):
        with pytest.raises(registry.ProfileNotEnrolled):
            await registry.set_route(c, source_id=source_id, profile_slug="coder",
                                     enabled=True, actor_user_id="john")

    _box(with_coder["dsn"], route)

    # The account-verb blast radius.
    assert asyncio.run(enrolled_profiles(
        "john", store_factory=principal_store_factory())) == ["default", "cfo", "cmo"]
    assert asyncio.run(registry.display_name_for("john")) == "John"


def test_a_configured_profile_that_cannot_connect_still_errors(box, monkeypatch):
    from starlette.testclient import TestClient

    from hermes_cli import web_server

    _add_profile(box, "coder", {"datastore": {"supabase_app": {"dsn": UNREACHABLE}}})

    _session_as(monkeypatch, "john")
    client = TestClient(web_server.app, raise_server_exceptions=False)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    assert client.get("/api/sources").status_code == 500
    with pytest.raises(OSError):
        asyncio.run(registry.active_profile_roles("john"))
