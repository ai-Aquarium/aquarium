"""FG-03 P2 — ``hermes source migrate`` on real Postgres and a real HERMES_HOME.

Three real profiles (``default``, ``cfo``, ``cmo``) over one throwaway
Postgres, each in its own schema. Today's sources are written by the real
writers (``email_mailboxes.save``, the credential store, ``bridge-owners.json``
in the format :mod:`hermes_cli.wa_bridge_owners` writes, and the poller config
files in the format the pollers read), then migrated into the box registry.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import asyncpg
import pytest
import yaml

import hermes_cli.datastore as datastore
from hermes_cli import source_migrate, source_registry
from hermes_cli.access import Principal, initialize_access
from hermes_cli.credential_store import SupabaseCredentialStore
from hermes_cli.datastore import get_store, initialize_supabase_app
from hermes_cli.source_migrate import Candidate, Discovery, SourcePaths
from tests.hermes_cli._pg_fixture import (  # noqa: F401 — pytest fixtures
    hermes_root,
    pg_config,
    postgres_dsn,
)

BOX = source_registry.BOX_SCHEMA

#: (user_id, role, active) per profile. John is suspended in cmo.
ROSTERS = {
    "default": [("leo", "owner", True), ("john", "member", True), ("mary", "member", True)],
    "cfo": [("leo", "owner", True), ("john", "member", True), ("mary", "member", True)],
    "cmo": [("leo", "owner", True), ("mary", "member", True), ("john", "member", False)],
}
MAILBOX = {
    "username": "me", "password": "app-password", "imap_host": "imap.acme.test", "imap_port": 993,
    "smtp_host": "smtp.acme.test", "smtp_port": 465,
}


async def _reset(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        for row in await connection.fetch(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%' OR nspname = $1", BOX
        ):
            await connection.execute(f'DROP SCHEMA "{row["nspname"]}" CASCADE')
        await initialize_supabase_app(connection)
    finally:
        await connection.close()


def _principal(user_id: str, profile: str) -> Principal:
    role, active = next((r, a) for u, r, a in ROSTERS[profile] if u == user_id)
    return Principal(user_id=user_id, display=user_id.title(), role=role, active=active)


async def _seed_profile(home: Path, dsn: str, profile: str) -> None:
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        datastore._verified_schemas.clear()
        store = get_store("supabase-app", "prod", config=pg_config(dsn))
        connection = await store.connect()
        try:
            await initialize_access(connection)
            await SupabaseCredentialStore(store).initialize(connection=connection)
            for user_id, role, active in ROSTERS[profile]:
                await connection.execute(
                    "INSERT INTO principals (user_id, display, role, active) VALUES ($1, $2, $3, $4)",
                    user_id, user_id.title(), role, active,
                )
        finally:
            await connection.close()


async def _save_mailbox(home: Path, profile: str, user_id: str, address: str) -> None:
    from hermes_cli import email_mailboxes
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        await email_mailboxes.save(_principal(user_id, profile), address, MAILBOX)


async def _save_bot(home: Path, dsn: str, profile: str, user_id: str, token: str) -> None:
    """A per-person bot exactly as ``telegram_bot_api._save`` stores it."""
    from hermes_cli.console_scope import _scoped_to
    from hermes_cli.telegram_bot_api import KIND, NAME, PROVIDER

    with _scoped_to(home):
        principal = _principal(user_id, profile)
        await SupabaseCredentialStore(get_store("supabase-app", "prod", config=pg_config(dsn))).put(
            principal, provider=PROVIDER, name=NAME, kind=KIND,
            payload={"token": token, "bot_username": f"{user_id}_bot", "linked_user_id": "4242"},
            services=[], visibility=principal.private_visibility,
        )


def _write_bridge(home: Path, name: str, user_id: str, port: int, number: str) -> None:
    """``bridge-owners.json`` as ``wa_bridge_owners.record_owner`` writes it, plus a linked session."""
    directory = home / "whatsapp"
    (directory / f"session-{name}").mkdir(parents=True)
    (directory / "bridge-owners.json").write_text(json.dumps(
        {name: {"user_id": user_id, "port": port, "added_at": int(time.time())}}
    ))
    (directory / f"session-{name}" / "creds.json").write_text(
        json.dumps({"me": {"id": f"{number}:7@s.whatsapp.net", "name": user_id}})
    )


@pytest.fixture
def box(postgres_dsn, hermes_root, tmp_path):  # noqa: F811
    from hermes_cli.profile_registry import get_profile_registry
    from hermes_cli.profiles import create_profile

    asyncio.run(_reset(postgres_dsn))
    (hermes_root / "config.yaml").write_text(yaml.safe_dump(pg_config(postgres_dsn)))
    for name in ("cfo", "cmo"):
        create_profile(name, clone_from="default", clone_config=True, no_alias=True)
    homes = {e.name: Path(e.hermes_home) for e in get_profile_registry()}
    for profile in ROSTERS:
        asyncio.run(_seed_profile(homes[profile], postgres_dsn, profile))

    # John saves his mailbox in cfo; later Mary saves the same address in cmo.
    asyncio.run(_save_mailbox(homes["cfo"], "cfo", "john", "John@Acme.test"))
    asyncio.run(_save_mailbox(homes["cmo"], "cmo", "mary", "john@acme.test"))
    # John's person bot lives in cmo, where he is suspended.
    asyncio.run(_save_bot(homes["cmo"], postgres_dsn, "cmo", "john", "5550001:secret-part"))
    # cfo's own install bot is not a person source.
    (homes["cfo"] / ".env").write_text("TELEGRAM_BOT_TOKEN=7770001:operator-secret\n")
    _write_bridge(homes["cfo"], "mary-phone", "mary", 3002, "85291230000")

    email_config = tmp_path / "email-messages" / "config.json"
    email_config.parent.mkdir()
    email_config.write_text(json.dumps({"accounts": [
        {"id": "email1", "address": "ops@acme.test", "label": "Ops", "auth": "password",
         "imap": {"host": "imap.acme.test", "port": 993, "tls": True}, "folders": ["INBOX"],
         "enabled": True},
        {"id": "email2", "address": "john@acme.test", "label": "John (shared poller)",
         "auth": "password", "imap": {"host": "imap.acme.test", "port": 993, "tls": True}},
    ]}))
    wa_config = tmp_path / "whatsapp-messages" / "config.json"
    wa_config.parent.mkdir()
    wa_config.write_text(json.dumps({"phones": [
        {"id": "phone1", "number": "+852 6123 4567", "label": "Phone 1", "bridge_port": 3000,
         "session_dir": str(tmp_path / "no-session"), "enabled": True},
        {"id": "phone2", "number": "+852****0978", "label": "Phone 2", "bridge_port": 3001,
         "session_dir": str(tmp_path / "no-session-2"), "enabled": True},
    ], "batching": {"window_seconds": 5}}))
    datastore._verified_schemas.clear()
    return {"dsn": postgres_dsn, "paths": SourcePaths(email_config, wa_config), "homes": homes}


def _run(box, *, dry_run: bool = False) -> dict:
    return asyncio.run(source_migrate.migrate_sources(
        dsn=box["dsn"], dry_run=dry_run, paths=box["paths"],
    ))


async def _snapshot(dsn: str) -> dict:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        if await connection.fetchval("SELECT to_regclass($1)", f"{BOX}.sources") is None:
            return {}
        return {
            table: [dict(r) for r in await connection.fetch(f"SELECT * FROM {BOX}.{table} ORDER BY 1, 2")]
            for table in ("sources", "source_routes", "source_claim_conflicts")
        }
    finally:
        await connection.close()


def _source(report: dict, channel: str, address: str) -> dict:
    return next(s for s in report["sources"] if (s["channel"], s["address"]) == (channel, address))


def _routes(source: dict) -> dict:
    return {r["profile"]: r["status"] for r in source["routes"]}


def test_migrates_todays_sources_with_one_owner_each(box):
    report = _run(box)
    assert report["install_owner_user_id"] == "leo"

    john = _source(report, "email", "john@acme.test")
    assert john["owner_user_id"] == "john"
    assert john["decided_by"] == "saved the mailbox credential"
    assert not john["assigned_to_install_owner"]
    # His own credential's profile, plus the box-wide poller entry (default);
    # Mary's cmo credential is hers, so it routes nothing for John.
    assert _routes(john) == {"cfo": "added", "default": "added"}

    phone = _source(report, "whatsapp", "85261234567")
    assert phone["owner_user_id"] == "leo"
    assert phone["assigned_to_install_owner"] is True
    assert _routes(phone) == {"default": "added"}

    ops = _source(report, "email", "ops@acme.test")
    assert ops["assigned_to_install_owner"] is True

    bridge = _source(report, "whatsapp", "85291230000")
    assert bridge["owner_user_id"] == "mary"
    assert _routes(bridge) == {"cfo": "added"}

    bot = _source(report, "telegram", "5550001")
    assert bot["owner_user_id"] == "john"
    assert bot["routes"] == [{
        "profile": "cmo", "status": "skipped",
        "reason": "owner john is not an active member of profile cmo",
    }]

    [conflict] = report["conflicts"]
    assert conflict["address"] == "john@acme.test"
    assert (conflict["claimant_user_id"], conflict["owner_user_id"]) == ("mary", "john")
    skipped = {s["item"]: s["reason"] for s in report["skipped"]}
    assert any("phone2" in item and "no full phone number" in reason for item, reason in skipped.items())
    assert any("install Telegram bot 7770001" in item for item in skipped)
    assert "secret" not in json.dumps(report)

    async def stored() -> tuple:
        connection = await source_registry.connect_box(dsn=box["dsn"])
        try:
            source = await source_registry.get_source_by_address(connection, "email", "John@acme.TEST")
            conflicts = await source_registry.list_conflicts(connection)
            return source, conflicts
        finally:
            await connection.close()

    source, conflicts = asyncio.run(stored())
    assert source.owner_user_id == "john"
    assert source.routed_profiles() == ["cfo", "default"]
    assert source.credential_ref == {
        "profile": "cfo", "kind": "email-imap", "provider": "imap",
        "name": "john@acme.test", "owner_user_id": "john",
    }
    assert [(c.claimant_user_id, c.existing_owner_user_id) for c in conflicts] == [("mary", "john")]
    assert "password" not in json.dumps(asyncio.run(_snapshot(box["dsn"])), default=str)


def test_rerun_changes_nothing(box):
    first = _run(box)
    assert source_migrate.changed(first) > 0
    before = asyncio.run(_snapshot(box["dsn"]))
    second = _run(box)
    assert source_migrate.changed(second) == 0
    assert {s["action"] for s in second["sources"]} == {"already registered"}
    assert [c["status"] for c in second["conflicts"]] == ["already recorded"]
    assert asyncio.run(_snapshot(box["dsn"])) == before


def test_dry_run_writes_nothing(box):
    dry = _run(box, dry_run=True)
    assert dry["dry_run"] is True
    assert asyncio.run(_snapshot(box["dsn"])) == {}  # not even the box schema
    real = _run(box)

    def shape(report: dict) -> list:
        return sorted((s["channel"], s["address"], s["owner_user_id"], s["action"], str(s["routes"]))
                      for s in report["sources"])

    assert shape(dry) == shape(real)
    assert source_migrate.changed(dry) == source_migrate.changed(real)
    before = asyncio.run(_snapshot(box["dsn"]))
    _run(box, dry_run=True)
    assert asyncio.run(_snapshot(box["dsn"])) == before


def test_a_registered_owner_is_kept_and_todays_claimant_gets_a_conflict(box):
    async def preregister() -> None:
        connection = await source_registry.connect_box(dsn=box["dsn"])
        try:
            await source_registry.register_source(
                connection, channel="whatsapp", address="+852 9123 0000", owner_user_id="leo",
            )
        finally:
            await connection.close()

    asyncio.run(preregister())
    report = _run(box)
    bridge = _source(report, "whatsapp", "85291230000")
    assert bridge["owner_user_id"] == "leo"
    assert bridge["action"] == "kept the registered owner"
    assert bridge["routes"] == []  # Mary's bridge profile is not Leo's route
    assert ("mary", "leo") in {
        (c["claimant_user_id"], c["owner_user_id"]) for c in report["conflicts"]
        if c["address"] == "85291230000"
    }


def test_db_migrate_runs_the_source_migration(box, monkeypatch):
    from hermes_cli import db_migrate

    async def no_tables(*_args, **_kwargs):
        return []

    monkeypatch.setattr(db_migrate, "migrate_store", no_tables)
    monkeypatch.setattr(source_migrate, "SourcePaths", lambda: box["paths"])
    rows = db_migrate.migrate(config=pg_config(box["dsn"]))
    [(mode, name, error)] = [r for r in rows if r[1].startswith("source registry migration")]
    assert (mode, error) == ("box", None)
    assert "conflict" in name and "john@acme.test" not in name
    assert asyncio.run(_snapshot(box["dsn"]))["sources"]


# -- the decision rule (no database) ---------------------------------------------


def _candidate(owner, rank, profile="cfo", created=None, **kw) -> Candidate:
    from datetime import datetime, timezone

    return Candidate(
        channel="email", address="a@b.test", owner_user_id=owner, rank=rank, profile=profile,
        found_in=f"{profile}: test", decided_by=f"rank {rank}",
        created_at=datetime.fromtimestamp(created, tz=timezone.utc) if created else None, **kw,
    )


def test_credential_owner_beats_a_config_entry():
    found = Discovery(install_owner_user_id="leo", candidates=[
        _candidate("mary", 1, profile="default", created=1),
        _candidate("john", 0, created=50),
    ])
    [item] = source_migrate.plan(found)
    assert item.owner_user_id == "john"
    assert list(item.losers) == ["mary"]


def test_tie_goes_to_the_earliest_created_and_unowned_entries_never_conflict():
    found = Discovery(install_owner_user_id="leo", candidates=[
        _candidate("mary", 0, created=20),
        _candidate("john", 0, created=10),
        _candidate(None, 1, profile="default"),
    ])
    [item] = source_migrate.plan(found)
    assert (item.owner_user_id, item.assigned_to_install_owner) == ("john", False)
    assert list(item.losers) == ["mary"]


def test_no_owner_and_no_install_owner_is_skipped():
    found = Discovery(candidates=[_candidate(None, 1)])
    assert source_migrate.plan(found) == []
    assert found.skipped[0]["reason"].startswith("no explicit owner")
