"""FG-03 P1 E2E — per-user profile folders follow real enrolments.

Real Postgres (one database, one derived schema per profile), a temp hermes
root with ``default``, ``cfo`` and ``cmo`` profiles, and the production seams:
``MemberService`` (console / CLI), ``resolve_principal`` (pairing auto-enrol),
``PrincipalStore`` built inside another profile's runtime scope, and the
box-wide backfill. GoTrue is the box-wide stub from ``_pg_fixture``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import asyncpg
import pytest

import hermes_cli.datastore as datastore
from agent.profile_runtime import profile_runtime_scope
from hermes_cli.access import Principal, PrincipalStore, resolve_principal
from hermes_cli.datastore import get_store, initialize_supabase_app
from hermes_cli.members import MemberService
from hermes_cli.user_profile_dirs import (
    archived_user_dirs_root,
    backfill_user_profile_dirs,
    user_profile_dir,
)
from tests.hermes_cli._pg_fixture import (  # noqa: F401 — pytest fixtures
    StubAdmin,
    console,
    hermes_root,
    pg_config,
    postgres_dsn,
)

PROFILES = ("default", "cfo", "cmo")
OWNER = Principal(user_id="leo_owner", display="Leo", role="owner")


def _home(root: Path, profile: str) -> Path:
    return root if profile == "default" else root / "profiles" / profile


def _folders(root: Path) -> set[tuple[str, str]]:
    found = set()
    for profile in PROFILES:
        users = _home(root, profile) / "users"
        if users.is_dir():
            found |= {
                (profile, p.name) for p in users.iterdir() if not p.name.startswith(".")
            }
    return found


async def _reset(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        for schema in ("app_prod", "app_prod_cfo", "app_prod_cmo", "app_dev"):
            await connection.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        await initialize_supabase_app(connection)
    finally:
        await connection.close()


async def _console(root, profile, dsn, admin, monkeypatch) -> MemberService:
    return await console(root, profile, dsn, admin, monkeypatch)


@pytest.mark.asyncio
async def test_two_users_in_two_profiles_get_four_folders_and_removal_archives_one(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _reset(postgres_dsn)
    admin = StubAdmin()
    ids: dict[str, str] = {}
    services: dict[str, MemberService] = {}
    for profile in ("cfo", "cmo"):
        services[profile] = service = await _console(
            hermes_root, profile, postgres_dsn, admin, monkeypatch
        )
        for name in ("john", "mary"):
            created = await service.create_member(
                OWNER, email=f"{name}@x.io", profile=profile, display=name.title()
            )
            ids[name] = created.principal.user_id

    john, mary = ids["john"], ids["mary"]
    # The second profile reused the box-wide accounts, so one id per person.
    assert len(admin.accounts) == 2
    # The console fixture seeds leo_owner by SQL (no hook), so only the four.
    assert _folders(hermes_root) == {
        ("cfo", john),
        ("cfo", mary),
        ("cmo", john),
        ("cmo", mary),
    }
    for profile in ("cfo", "cmo"):
        for uid in (john, mary):
            assert (
                user_profile_dir(uid, _home(hermes_root, profile)).stat().st_mode
                & 0o777
            ) == 0o700

    cfo_home = _home(hermes_root, "cfo")
    marker = user_profile_dir(john, cfo_home) / "triage.md"
    marker.write_text("john's CFO triage")

    # Remove John from CFO only: the process is scoped to CFO, as in prod.
    monkeypatch.setenv("HERMES_HOME", str(cfo_home))
    datastore._verified_schemas.clear()
    await services["cfo"].delete_member(
        OWNER, user_id=john, strategy="transfer", transfer_to="leo_owner"
    )

    assert _folders(hermes_root) == {("cfo", mary), ("cmo", john), ("cmo", mary)}
    archives = list(archived_user_dirs_root(john, cfo_home).iterdir())
    assert len(archives) == 1
    assert (archives[0] / "triage.md").read_text() == "john's CFO triage"
    assert not (_home(hermes_root, "cmo") / "users" / ".archived").exists()

    # Suspend Mary in CMO → archived; restore → her own folder comes back.
    cmo_home = _home(hermes_root, "cmo")
    monkeypatch.setenv("HERMES_HOME", str(cmo_home))
    datastore._verified_schemas.clear()
    (user_profile_dir(mary, cmo_home) / "triage.md").write_text("mary's CMO triage")
    await services["cmo"].set_member_active(OWNER, user_id=mary, active=False)
    assert ("cmo", mary) not in _folders(hermes_root)
    assert len(list(archived_user_dirs_root(mary, cmo_home).iterdir())) == 1
    await services["cmo"].set_member_active(OWNER, user_id=mary, active=True)
    assert (user_profile_dir(mary, cmo_home) / "triage.md").read_text() == (
        "mary's CMO triage"
    )
    assert not archived_user_dirs_root(mary, cmo_home).exists()

    # Re-add John to CFO → his archived CFO folder is restored, not wiped.
    monkeypatch.setenv("HERMES_HOME", str(cfo_home))
    datastore._verified_schemas.clear()
    again = await services["cfo"].create_member(
        OWNER, email="john@x.io", profile="cfo", display="John"
    )
    assert again.principal.user_id == john
    assert marker.read_text() == "john's CFO triage"
    assert not archived_user_dirs_root(john, cfo_home).exists()
    assert _folders(hermes_root) == {
        ("cfo", john),
        ("cfo", mary),
        ("cmo", john),
        ("cmo", mary),
    }


@pytest.mark.asyncio
async def test_enrolling_into_a_non_active_profile_writes_under_that_profile(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The process is the default profile; the console scopes a call into CMO."""
    await _reset(postgres_dsn)
    cmo_home = _home(hermes_root, "cmo")
    cmo_home.mkdir(parents=True, exist_ok=True)
    _home(hermes_root, "cfo").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(hermes_root))

    with profile_runtime_scope(cmo_home):
        store = PrincipalStore(
            get_store("supabase-app", "prod", config=pg_config(postgres_dsn))
        )
        await store.enroll("john", display="John")
    assert store.app_store.schema == "app_prod_cmo"
    assert _folders(hermes_root) == {("cmo", "john")}

    # A store for CFO's schema used from an unscoped (default) context still
    # lands in CFO: the folder follows the schema, not the caller's home.
    with profile_runtime_scope(_home(hermes_root, "cfo")):
        cfo_store = get_store("supabase-app", "prod", config=pg_config(postgres_dsn))
    await PrincipalStore(cfo_store).enroll("mary", display="Mary")
    assert _folders(hermes_root) == {("cmo", "john"), ("cfo", "mary")}


@dataclass
class _Origin:
    platform: str
    user_id: str
    user_name: str = ""


@pytest.mark.asyncio
async def test_pairing_auto_enrolment_creates_the_folder(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _reset(postgres_dsn)
    cfo_home = _home(hermes_root, "cfo")
    cfo_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(cfo_home))
    datastore._verified_schemas.clear()
    store = PrincipalStore(
        get_store("supabase-app", "prod", config=pg_config(postgres_dsn))
    )

    principal = await resolve_principal(
        _Origin("telegram", "4242", "Paired"),
        store=store,
        is_paired=lambda _p, _u: True,
    )
    assert principal is not None
    assert _folders(hermes_root) == {("cfo", "4242")}


@pytest.mark.asyncio
async def test_backfill_creates_folders_for_active_principals_in_every_profile(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _reset(postgres_dsn)
    rows = {
        "default": [("leo_owner", "owner", True)],
        "cfo": [
            ("leo_owner", "owner", True),
            ("john", "member", True),
            ("gone", "member", False),
        ],
        "cmo": [("leo_owner", "owner", True), ("mary", "admin", True)],
    }
    for profile, principals in rows.items():
        home = _home(hermes_root, profile)
        home.mkdir(parents=True, exist_ok=True)
        with profile_runtime_scope(home):
            store = get_store("supabase-app", "prod", config=pg_config(postgres_dsn))
            connection = await store.connect()
            try:
                from hermes_cli.access import initialize_access

                await initialize_access(connection)
                for uid, role, active in principals:
                    # Straight SQL: the pre-FG-03 rows that never ran the hook.
                    await connection.execute(
                        "INSERT INTO principals (user_id, display, role, active) "
                        "VALUES ($1, $1, $2, $3)",
                        uid,
                        role,
                        active,
                    )
            finally:
                await connection.close()
    # One profile with no datastore at all is skipped, not fatal.
    (hermes_root / "profiles" / "coreonly").mkdir()
    (hermes_root / "profiles" / "coreonly" / "config.yaml").write_text("{}\n")
    assert _folders(hermes_root) == set()

    expected = {
        ("default", "leo_owner"),
        ("cfo", "leo_owner"),
        ("cfo", "john"),
        ("cmo", "leo_owner"),
        ("cmo", "mary"),
    }

    # Production reads each profile's own config.yaml for its DSN.
    for profile in PROFILES:
        (_home(hermes_root, profile) / "config.yaml").write_text(
            f"datastore:\n  supabase_app:\n    dsn: {postgres_dsn}\n"
        )

    dry = await backfill_user_profile_dirs(dry_run=True)
    assert _folders(hermes_root) == set()
    assert {
        (r.home.name if r.home != hermes_root else "default", uid)
        for r in dry
        for uid in r.created
    } == expected

    reports = await backfill_user_profile_dirs()
    by_home = {r.home: r for r in reports}
    assert by_home[hermes_root / "profiles" / "coreonly"].skipped
    assert _folders(hermes_root) == expected
    assert ("cfo", "gone") not in _folders(hermes_root)

    again = await backfill_user_profile_dirs()
    assert all(not r.created for r in again)
    assert sum(len(r.existing) for r in again) == len(expected)
