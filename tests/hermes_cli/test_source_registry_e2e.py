"""FG-03 P2 E2E — the box-level source registry on real Postgres.

Real profiles (``default``, ``cfo``, ``cmo``, plus ``hr`` that John is not in)
made by the profile API over a tmp hermes root and one throwaway Postgres, each
in its own derived schema; the registry lives in ``aquarium_box`` beside them.
Membership checks go through each profile's own ``principals`` (the real
registry and runtime scope), and the API runs through the real route table.
The only stand-ins are the login gate's subject and GoTrue.
"""

from __future__ import annotations

import argparse
import asyncio
import json

import asyncpg
import pytest
import yaml

import hermes_cli.datastore as datastore
from hermes_cli import source_registry as registry
from hermes_cli.access import PrincipalStore, initialize_access
from hermes_cli.changes import initialize_changes
from hermes_cli.datastore import get_store, initialize_supabase_app
from hermes_cli.invitations import initialize_invitations
from tests.hermes_cli._pg_fixture import (  # noqa: F401 — pytest fixtures
    StubAdmin,
    hermes_root,
    pg_config,
    postgres_dsn,
)

SUBJECT_HEADER = "X-Test-Subject"
MAILBOX = "john@example.com"

#: (user_id, role, active) per profile. John: default + cfo + cmo, not hr.
ROSTERS: dict[str, list[tuple[str, str, bool]]] = {
    "default": [("leo", "owner", True), ("john", "member", True), ("mary", "member", True)],
    "cfo": [("cfo_owner", "owner", True), ("john", "member", True), ("mary", "member", True)],
    "cmo": [("cmo_owner", "owner", True), ("john", "member", True), ("sus", "member", False)],
    "hr": [("hr_owner", "owner", True), ("mary", "member", True)],
}


async def _reset(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        for row in await connection.fetch(
            "SELECT nspname FROM pg_namespace "
            "WHERE nspname LIKE 'app\\_%' OR nspname = $1",
            registry.BOX_SCHEMA,
        ):
            await connection.execute(f'DROP SCHEMA "{row["nspname"]}" CASCADE')
        await initialize_supabase_app(connection)
    finally:
        await connection.close()


async def _seed(home, dsn: str, roster) -> None:
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        datastore._verified_schemas.clear()
        connection = await get_store("supabase-app", "prod", config=pg_config(dsn)).connect()
        try:
            await initialize_access(connection)
            await initialize_invitations(connection)
            await initialize_changes(connection)
            for user_id, role, active in roster:
                await connection.execute(
                    "INSERT INTO principals (user_id, display, role, active) "
                    "VALUES ($1, $2, $3, $4)",
                    user_id, user_id.title(), role, active,
                )
        finally:
            await connection.close()


@pytest.fixture
def box(postgres_dsn, hermes_root, monkeypatch):  # noqa: F811
    from hermes_cli import web_server
    from hermes_cli.profile_registry import get_profile_registry
    from hermes_cli.profiles import create_profile

    asyncio.run(_reset(postgres_dsn))
    (hermes_root / "config.yaml").write_text(yaml.safe_dump(pg_config(postgres_dsn)))
    for name in ROSTERS:
        if name != "default":
            create_profile(name, clone_from="default", clone_config=True, no_alias=True)
    homes = {e.name: e.hermes_home for e in get_profile_registry()}
    for name, roster in ROSTERS.items():
        asyncio.run(_seed(homes[name], postgres_dsn, roster))
    datastore._verified_schemas.clear()
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: (request.headers.get(SUBJECT_HEADER) or "").strip(),
    )
    return {"dsn": postgres_dsn, "homes": homes}


def _box(dsn, fn):
    async def run():
        connection = await registry.connect_box(dsn=dsn)
        try:
            return await fn(connection)
        finally:
            await connection.close()

    return asyncio.run(run())


def _client(user_id: str):
    from starlette.testclient import TestClient

    from hermes_cli import web_server

    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    client.headers[SUBJECT_HEADER] = user_id
    return client


def _session_as(monkeypatch, user_id: str):
    """A request carrying a verified session for ``user_id`` (the real gate's shape)."""
    from types import SimpleNamespace

    from hermes_cli import web_server

    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: user_id)
    # Loopback-token mode and no bound host, whatever an earlier test left on
    # the shared app.
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    monkeypatch.setattr(web_server.app.state, "bound_host", None, raising=False)
    return SimpleNamespace(user_id=user_id)


# -- normalisation (no database) ----------------------------------------------


@pytest.mark.parametrize(
    ("channel", "raw", "expected"),
    [
        ("email", "John@Example.com", "john@example.com"),
        ("email", "  <JOHN@example.COM> ", "john@example.com"),
        ("email", "mailto:john@example.com", "john@example.com"),
        ("whatsapp", "+852 9123-4567", "85291234567"),
        ("whatsapp", "0085291234567", "85291234567"),
        ("whatsapp", "85291234567@s.whatsapp.net", "85291234567"),
        ("whatsapp", "whatsapp:+85291234567", "85291234567"),
        ("telegram", "123456789", "123456789"),
        ("telegram", "123456789:AAF-secret-part", "123456789"),
    ],
)
def test_normalize_address(channel, raw, expected):
    assert registry.normalize_address(channel, raw) == expected


@pytest.mark.parametrize(
    ("channel", "raw"),
    [("email", "not-an-email"), ("whatsapp", "12ab"), ("telegram", "@my_bot"), ("sms", "1")],
)
def test_normalize_address_refuses_garbage(channel, raw):
    with pytest.raises(registry.SourceRegistryError):
        registry.normalize_address(channel, raw)


def test_credential_ref_refuses_secrets():
    with pytest.raises(registry.SourceRegistryError):
        registry._check_credential_ref({"profile": "cfo", "password": "hunter2"})
    with pytest.raises(registry.SourceRegistryError):
        registry._check_credential_ref({"token": "123:abc"})
    assert registry._check_credential_ref(
        {"profile": "cfo", "kind": "email-imap", "name": MAILBOX}
    ) == {"profile": "cfo", "kind": "email-imap", "name": MAILBOX}


# -- the store ------------------------------------------------------------------


def test_one_owner_per_source_and_owner_only_routes(box):
    dsn = box["dsn"]

    async def scenario(c):
        src = await registry.register_source(
            c, channel="email", address="John@Example.com", owner_user_id="john",
            display="John's mailbox",
            credential_ref={"profile": "cfo", "kind": "email-imap", "name": MAILBOX},
        )
        assert src.address == MAILBOX
        # Same owner, different spelling: the same source, idempotent.
        again = await registry.register_source(
            c, channel="email", address="john@example.com", owner_user_id="john"
        )
        assert again.source_id == src.source_id
        assert again.display == "John's mailbox"
        assert len(await registry.list_sources(c)) == 1

        for profile in ("cfo", "cmo"):
            route = await registry.set_route(
                c, source_id=src.source_id, profile_slug=profile, enabled=True,
                actor_user_id="john",
            )
            assert route.enabled
        assert await registry.routed_profiles(c, src.source_id) == ["cfo", "cmo"]

        # Mary claiming the same mailbox is refused, naming nobody.
        with pytest.raises(registry.SourceOwnedByAnotherUser) as refused:
            await registry.register_source(
                c, channel="email", address="JOHN@example.com", owner_user_id="mary"
            )
        assert "already registered to another user" in str(refused.value)
        assert "john" not in str(refused.value).replace(MAILBOX, "")
        conflicts = await registry.list_conflicts(c)
        assert [(x.claimant_user_id, x.existing_owner_user_id) for x in conflicts] == [
            ("mary", "john")
        ]
        # Refusing twice keeps one open conflict.
        with pytest.raises(registry.SourceOwnedByAnotherUser):
            await registry.register_source(
                c, channel="email", address=MAILBOX, owner_user_id="mary"
            )
        assert len(await registry.list_conflicts(c)) == 1
        assert (await registry.get_source_by_address(c, "email", MAILBOX)).owner_user_id == "john"

        # John cannot route to a profile he is not in (hr), nor to a missing one.
        for profile in ("hr", "nope"):
            with pytest.raises(registry.ProfileNotEnrolled):
                await registry.set_route(
                    c, source_id=src.source_id, profile_slug=profile, enabled=True,
                    actor_user_id="john",
                )

        # Mary cannot change John's routes, on or off, nor remove his source.
        for enabled in (True, False):
            with pytest.raises(registry.SourcePermissionError):
                await registry.set_route(
                    c, source_id=src.source_id, profile_slug="cfo", enabled=enabled,
                    actor_user_id="mary",
                )
        with pytest.raises(registry.SourcePermissionError):
            await registry.remove_source(c, source_id=src.source_id, actor_user_id="mary")
        assert await registry.routed_profiles(c, src.source_id) == ["cfo", "cmo"]

        # Unroute is the owner's; listing carries the routes.
        await registry.set_route(
            c, source_id=src.source_id, profile_slug="cmo", enabled=False, actor_user_id="john"
        )
        [listed] = await registry.list_sources(c, owner_user_id="john")
        assert {r.profile_slug: r.enabled for r in listed.routes} == {"cfo": True, "cmo": False}
        assert listed.routed_profiles() == ["cfo"]
        assert await registry.list_sources(c, owner_user_id="mary") == []
        return src

    _box(dsn, scenario)


def test_suspended_member_cannot_route(box):
    async def scenario(c):
        src = await registry.register_source(
            c, channel="telegram", address="555:secret", owner_user_id="sus"
        )
        assert src.address == "555"
        with pytest.raises(registry.ProfileNotEnrolled):
            await registry.set_route(
                c, source_id=src.source_id, profile_slug="cmo", enabled=True,
                actor_user_id="sus",
            )

    _box(box["dsn"], scenario)


def test_transfer_is_box_admin_only_and_drops_routes(box):
    async def scenario(c):
        src = await registry.register_source(
            c, channel="whatsapp", address="+852 9123 4567", owner_user_id="john"
        )
        await registry.set_route(
            c, source_id=src.source_id, profile_slug="cfo", enabled=True, actor_user_id="john"
        )
        with pytest.raises(registry.SourceOwnedByAnotherUser):
            await registry.register_source(
                c, channel="whatsapp", address="85291234567", owner_user_id="mary"
            )
        for actor in ("john", "mary", "cfo_owner"):
            with pytest.raises(registry.SourcePermissionError):
                await registry.transfer_source(
                    c, source_id=src.source_id, new_owner_user_id="mary", actor_user_id=actor
                )
        moved = await registry.transfer_source(
            c, source_id=src.source_id, new_owner_user_id="mary", actor_user_id="leo"
        )
        assert moved.owner_user_id == "mary" and moved.routes == ()
        assert await registry.list_conflicts(c) == []
        assert len(await registry.list_conflicts(c, include_resolved=True)) == 1
        # Now John may not touch it; the box admin can remove it.
        with pytest.raises(registry.SourcePermissionError):
            await registry.set_route(
                c, source_id=src.source_id, profile_slug="cfo", enabled=True,
                actor_user_id="john",
            )
        assert await registry.remove_source(c, source_id=src.source_id, actor_user_id="leo")
        assert await registry.get_source(c, src.source_id) is None

    _box(box["dsn"], scenario)


# -- lifecycle hooks --------------------------------------------------------------


def _in_profile(box, profile, fn):
    from hermes_cli.console_scope import _scoped_to

    async def run():
        with _scoped_to(box["homes"][profile]):
            datastore._verified_schemas.clear()
            store = PrincipalStore(get_store("supabase-app", "prod", config=pg_config(box["dsn"])))
            return await fn(store)

    return asyncio.run(run())


def _john_routed(box):
    async def scenario(c):
        src = await registry.register_source(
            c, channel="email", address=MAILBOX, owner_user_id="john"
        )
        for profile in ("cfo", "cmo"):
            await registry.set_route(
                c, source_id=src.source_id, profile_slug=profile, enabled=True,
                actor_user_id="john",
            )
        mary = await registry.register_source(
            c, channel="email", address="mary@example.com", owner_user_id="mary"
        )
        await registry.set_route(
            c, source_id=mary.source_id, profile_slug="cfo", enabled=True, actor_user_id="mary"
        )
        return src.source_id, mary.source_id

    return _box(box["dsn"], scenario)


def test_removing_john_from_cfo_disables_only_that_route(box):
    john_src, mary_src = _john_routed(box)
    assert _in_profile(box, "cfo", lambda s: s.unenroll("john")) is True

    assert _box(box["dsn"], lambda c: registry.routed_profiles(c, john_src)) == ["cmo"]
    [src] = _box(box["dsn"], lambda c: registry.list_sources(c, owner_user_id="john"))
    assert {r.profile_slug: r.enabled for r in src.routes} == {"cfo": False, "cmo": True}
    # Mary's CFO route is untouched.
    assert _box(box["dsn"], lambda c: registry.routed_profiles(c, mary_src)) == ["cfo"]


def test_suspending_john_in_cmo_disables_that_route(box):
    john_src, _ = _john_routed(box)
    _in_profile(box, "cmo", lambda s: s.set_active("john", False))
    assert _box(box["dsn"], lambda c: registry.routed_profiles(c, john_src)) == ["cfo"]


def test_removing_john_from_the_box_removes_his_sources(box):
    from hermes_cli.members import MemberService

    john_src, mary_src = _john_routed(box)

    async def delete(store, owner):
        actor = await store.get(owner)
        service = MemberService(store, StubAdmin(), config=pg_config(box["dsn"]))
        await service.delete_member(
            actor, user_id="john", strategy="transfer", transfer_to=owner
        )

    _in_profile(box, "cfo", lambda s: delete(s, "cfo_owner"))
    _in_profile(box, "default", lambda s: delete(s, "leo"))
    # Still in cmo: his source stays, routed only there.
    assert _box(box["dsn"], lambda c: registry.routed_profiles(c, john_src)) == ["cmo"]
    _in_profile(box, "cmo", lambda s: delete(s, "cmo_owner"))
    assert _box(box["dsn"], lambda c: registry.get_source(c, john_src)) is None
    assert _box(box["dsn"], lambda c: registry.get_source(c, mary_src)) is not None


# -- schema + migrate ---------------------------------------------------------------


def test_migrate_box_creates_a_schema_no_profile_claims(box):
    from hermes_cli.db_migrate import migrate_box

    for _ in range(2):  # idempotent
        rows = asyncio.run(migrate_box(box["dsn"]))
        assert rows == [("source registry", None), ("hermes_app grants", None)]

    async def inspect():
        c = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            return (
                await c.fetchval(f"SELECT kind FROM {registry.BOX_SCHEMA}.box_marker"),
                await c.fetchval("SELECT to_regclass('aquarium_box.schema_owner')"),
                await c.fetchval(
                    "SELECT has_table_privilege('hermes_app', 'aquarium_box.sources', 'INSERT')"
                ),
            )
        finally:
            await c.close()

    assert asyncio.run(inspect()) == (registry.BOX_MARKER_KIND, None, True)


def test_connect_box_refuses_a_schema_a_profile_claimed(box):
    async def claim():
        c = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            await c.execute(f"CREATE SCHEMA IF NOT EXISTS {registry.BOX_SCHEMA}")
            await c.execute(
                f"CREATE TABLE {registry.BOX_SCHEMA}.schema_owner (singleton BOOLEAN)"
            )
        finally:
            await c.close()

    asyncio.run(claim())
    with pytest.raises(registry.BoxSchemaError):
        _box(box["dsn"], lambda c: registry.list_sources(c))


# -- API ---------------------------------------------------------------------------


def test_api_owner_only_writes(box, monkeypatch):
    _session_as(monkeypatch, "john")
    john = _client("john")
    r = john.post("/api/sources", json={"channel": "email", "address": "John@Example.com"})
    assert r.status_code == 200, r.text
    source_id = r.json()["source"]["source_id"]
    for profile in ("cfo", "cmo"):
        r = john.put(f"/api/sources/{source_id}/routes/{profile}", json={"enabled": True})
        assert r.status_code == 200, r.text
    r = john.put(f"/api/sources/{source_id}/routes/hr", json={"enabled": True})
    assert r.status_code == 403
    body = john.get("/api/sources").json()
    assert [s["address"] for s in body["sources"]] == [MAILBOX]
    assert sorted(body["profiles"]) == ["cfo", "cmo", "default"]
    assert body["is_box_admin"] is False
    assert john.get("/api/sources?all=1").status_code == 403

    _session_as(monkeypatch, "mary")
    mary = _client("mary")
    r = mary.post("/api/sources", json={"channel": "email", "address": MAILBOX})
    assert r.status_code == 409
    assert "already registered to another user" in r.json()["detail"]
    assert mary.put(f"/api/sources/{source_id}/routes/cfo", json={"enabled": False}).status_code == 403
    assert mary.delete(f"/api/sources/{source_id}").status_code == 403
    assert mary.get("/api/sources").json()["sources"] == []
    assert [c["claimant_user_id"] for c in mary.get("/api/sources/conflicts").json()["conflicts"]] == ["mary"]
    r = mary.post(f"/api/sources/{source_id}/transfer", json={"new_owner_user_id": "mary"})
    assert r.status_code == 403

    _session_as(monkeypatch, "leo")
    leo = _client("leo")
    body = leo.get("/api/sources?all=1").json()
    assert body["is_box_admin"] is True
    assert [s["owner_user_id"] for s in body["sources"]] == ["john"]
    # The box admin sees everyone's but cannot route John's source.
    assert leo.put(f"/api/sources/{source_id}/routes/cfo", json={"enabled": False}).status_code == 403

    _session_as(monkeypatch, "john")
    assert john.delete(f"/api/sources/{source_id}").json() == {"deleted": True}
    assert john.get("/api/sources").json()["sources"] == []


# -- CLI ---------------------------------------------------------------------------


def _cli(argv, capsys):
    from hermes_cli.source_cli import register_source_subparser

    parser = argparse.ArgumentParser()
    register_source_subparser(parser.add_subparsers(dest="command"))
    args = parser.parse_args(["source", *argv])
    assert args.func(args) == 0
    return json.loads(capsys.readouterr().out)


def test_cli_json(box, capsys):
    reg = _cli(["register", "email", "John@Example.com", "--owner", "john", "--json"], capsys)
    assert reg["source"]["address"] == MAILBOX
    routed = _cli(["route", f"email:{MAILBOX}", "cfo", "--as", "john", "--json"], capsys)
    assert routed["route"] == {**routed["route"], "profile": "cfo", "enabled": True}
    listed = _cli(["list", "--as", "john", "--json"], capsys)
    assert [r["profile"] for r in listed["sources"][0]["routes"]] == ["cfo"]
    _cli(["unroute", reg["source"]["source_id"], "cfo", "--as", "john", "--json"], capsys)
    assert _cli(["list", "--all", "--json"], capsys)["sources"][0]["routes"][0]["enabled"] is False

    from hermes_cli.source_cli import register_source_subparser

    parser = argparse.ArgumentParser()
    register_source_subparser(parser.add_subparsers(dest="command"))
    args = parser.parse_args(["source", "register", "email", MAILBOX, "--owner", "mary"])
    with pytest.raises(SystemExit):
        args.func(args)
    assert "already registered to another user" in capsys.readouterr().err
    assert len(_cli(["conflicts", "--json"], capsys)["conflicts"]) == 1
    # Default actor is the default profile's owner (leo), who doesn't own it.
    args = parser.parse_args(["source", "route", f"email:{MAILBOX}", "cmo"])
    with pytest.raises(SystemExit):
        args.func(args)
    capsys.readouterr()
    assert _cli(["remove", f"email:{MAILBOX}", "--as", "john", "--json"], capsys) == {"deleted": True}
