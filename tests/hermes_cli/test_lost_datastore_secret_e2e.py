"""A profile whose datastore secret is lost, on real Postgres (Devin Review on #990).

``engineers`` is configured as ``dsn: ${ENGINEERS_DATABASE_URL}`` and still
enrols people, but the variable is unset, so its rows cannot be read. Listings
may skip it; an authorization decision that would grant from "not enrolled
there" must refuse instead. A profile never given a datastore (no ``dsn`` key,
like production's coder profiles) has no rows to hide and does not block.
Real profiles, schemas and route table from ``test_fg28_console_matrix_e2e``.
"""

from __future__ import annotations

import asyncio

import pytest
import yaml

from hermes_cli.datastore import DatastoreSecretMissing
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401 — pytest fixtures
from tests.hermes_cli.test_fg28_console_matrix_e2e import (  # noqa: F401 — pytest fixture
    _as,
    _fetch,
    _snapshot,
    box,
)

SECRET = "ENGINEERS_DATABASE_URL"


def _home(name: str):
    from hermes_cli.profile_registry import get_profile_registry

    return next(e.hermes_home for e in get_profile_registry() if e.name == name)


def _set_dsn(name: str, dsn) -> None:
    path = _home(name) / "config.yaml"
    config = (yaml.safe_load(path.read_text()) if path.exists() else None) or {}
    if dsn is None:
        config.pop("datastore", None)
    else:
        config.setdefault("datastore", {}).setdefault("supabase_app", {})["dsn"] = dsn
    path.write_text(yaml.safe_dump(config))


def _enrol(box, profile: str, user_id: str) -> None:
    asyncio.run(_fetch(
        box["dsn"],
        f"INSERT INTO {box['schemas'][profile]}.principals (user_id, display, role, active) "
        "VALUES ($1, $2, 'member', true) RETURNING user_id",
        user_id, user_id.title(),
    ))


@pytest.fixture
def lost_secret(box, monkeypatch):
    # ``hiro`` (never activated) and ``shared`` are now both hr + engineers.
    _enrol(box, "engineers", "hiro")
    monkeypatch.delenv(SECRET, raising=False)
    _set_dsn("engineers", "${%s}" % SECRET)
    return box


def test_another_profiles_admin_cannot_mint_a_link_for_a_member_of_a_lost_profile(
    lost_secret,
):
    client = lost_secret["client"]
    before = _snapshot(lost_secret, "hr")
    res = client.post(
        "/api/comms/members/hiro/invitation", params={"profile": "hr"}, headers=_as("cfo")
    )
    assert res.status_code == 403, res.text
    assert _snapshot(lost_secret, "hr") == before


def test_listings_skip_a_lost_profile_but_box_wide_checks_refuse(lost_secret):
    from hermes_cli import source_registry as registry
    from hermes_cli.console_scope import enrolled_profiles, principal_store_factory

    assert asyncio.run(
        enrolled_profiles("hiro", store_factory=principal_store_factory())
    ) == ["hr"]
    res = lost_secret["client"].get("/api/auth/my-profiles", headers=_as("shared"))
    assert res.status_code == 200, res.text
    assert "engineers" not in [p["name"] for p in res.json()["profiles"]]
    with pytest.raises(DatastoreSecretMissing, match="engineers"):
        asyncio.run(registry.active_or_suspended_anywhere("hiro"))


def test_a_reset_request_is_not_minted_elsewhere_when_a_profile_is_unreadable(
    lost_secret,
):
    before = _snapshot(lost_secret, "hr")
    res = lost_secret["client"].post(
        "/api/auth/invitations/request",
        json={"email": "shared@box.test", "profile": "hr"},
    )
    assert res.status_code == 200, res.text
    assert _snapshot(lost_secret, "hr") == before


def test_a_never_configured_profile_does_not_block_the_link(box):
    from hermes_cli.profiles import create_profile

    create_profile("coder", no_alias=True, verify_datastore=False)
    _set_dsn("coder", None)
    res = box["client"].post(
        "/api/comms/members/hiro/invitation", params={"profile": "hr"}, headers=_as("cfo")
    )
    assert res.status_code == 200, res.text
    assert [r["user_id"] for r in _snapshot(box, "hr")["invitations"]] == ["hiro"]

    # The control for the reset test: with every profile readable it is minted.
    res = box["client"].post(
        "/api/auth/invitations/request", json={"email": "shared@box.test", "profile": "hr"}
    )
    assert res.status_code == 200, res.text
    assert {(r["user_id"], r["kind"]) for r in _snapshot(box, "hr")["invitations"]} == {
        ("hiro", "activation"), ("shared", "recovery")
    }
