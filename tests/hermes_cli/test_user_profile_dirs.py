"""FG-03 P1 — per-user profile folders: create, archive, resolve, backfill.

Filesystem-only claims against a temp hermes root with several profiles; the
real-Postgres enrolment paths are in ``test_fg03_user_profile_dirs_e2e.py``.
"""

from __future__ import annotations

import asyncio
import os
import stat
from datetime import datetime, timezone
from pathlib import Path

import pytest

import hermes_constants
from hermes_cli import user_profile_dirs as upd
from hermes_cli.access import PrincipalStore
from hermes_cli.datastore import SupabaseAppStore

NOW = datetime(2026, 11, 16, 4, 5, 6, tzinfo=timezone.utc)


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "hermes-root"
    for name in ("cfo", "cmo"):
        (root / "profiles" / name).mkdir(parents=True)
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    monkeypatch.setenv("HERMES_HOME", str(root))
    return root


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_ensure_creates_a_private_folder_and_is_idempotent(root: Path) -> None:
    home = root / "profiles" / "cfo"
    folder = upd.ensure_user_profile_dir("john", home)
    assert folder == home / "users" / "john"
    assert folder.is_dir()
    assert _mode(folder) == 0o700
    assert _mode(home / "users") == 0o700

    (folder / "note.md").write_text("mine")
    assert upd.ensure_user_profile_dir("john", home) == folder
    assert (folder / "note.md").read_text() == "mine"


@pytest.mark.parametrize(
    "bad", ["../escape", "..", "a/b", "/abs", "", " ", ".archived", "x\x00y"]
)
def test_path_traversal_and_reserved_ids_are_refused(root: Path, bad: str) -> None:
    home = root / "profiles" / "cfo"
    with pytest.raises(ValueError):
        upd.ensure_user_profile_dir(bad, home)
    with pytest.raises(ValueError):
        upd.archive_user_profile_dir(bad, home)
    assert not (home / "users").exists() or list((home / "users").iterdir()) == []
    assert not (root / "escape").exists()


def test_a_symlinked_user_folder_is_refused(root: Path, tmp_path: Path) -> None:
    home = root / "profiles" / "cfo"
    outside = tmp_path / "outside"
    outside.mkdir()
    (home / "users").mkdir()
    (home / "users" / "john").symlink_to(outside)
    with pytest.raises(ValueError):
        upd.ensure_user_profile_dir("john", home)
    with pytest.raises(ValueError):
        upd.archive_user_profile_dir("john", home)
    assert outside.is_dir()


def test_missing_profile_home_is_not_created(root: Path) -> None:
    with pytest.raises(FileNotFoundError):
        upd.ensure_user_profile_dir("john", root / "profiles" / "nope")
    assert not (root / "profiles" / "nope").exists()


def test_archive_moves_never_deletes_and_nests_by_user(root: Path) -> None:
    home = root / "profiles" / "cfo"
    folder = upd.ensure_user_profile_dir("john", home)
    (folder / "skill.md").write_text("custom")

    archived = upd.archive_user_profile_dir("john", home, now=NOW)

    assert archived == home / "users" / ".archived" / "john" / "20261116T040506Z"
    assert archived == upd.archived_user_dirs_root("john", home) / "20261116T040506Z"
    assert (archived / "skill.md").read_text() == "custom"
    assert not folder.exists()
    assert _mode(home / "users" / ".archived") == 0o700
    assert _mode(home / "users" / ".archived" / "john") == 0o700


def test_same_second_archives_get_a_suffix_and_reenrolment_is_fresh(root: Path) -> None:
    home = root / "profiles" / "cfo"
    first = upd.ensure_user_profile_dir("john", home)
    (first / "a").write_text("1")
    one = upd.archive_user_profile_dir("john", home, now=NOW)

    second = upd.ensure_user_profile_dir("john", home)
    assert list(second.iterdir()) == []  # fresh, not restored
    (second / "b").write_text("2")
    two = upd.archive_user_profile_dir("john", home, now=NOW)

    assert one is not None and two is not None
    assert one.name == "20261116T040506Z"
    assert two.name == "20261116T040506Z-1"
    assert (one / "a").read_text() == "1"
    assert (two / "b").read_text() == "2"


def test_archiving_with_no_folder_is_a_no_op(root: Path) -> None:
    assert upd.archive_user_profile_dir("ghost", root / "profiles" / "cfo") is None
    assert not (root / "profiles" / "cfo" / "users").exists()


def test_archive_prefixes_do_not_collide(root: Path) -> None:
    home = root / "profiles" / "cfo"
    upd.ensure_user_profile_dir("john", home)
    upd.ensure_user_profile_dir("john-1", home)
    upd.archive_user_profile_dir("john", home, now=NOW)
    upd.archive_user_profile_dir("john-1", home, now=NOW)
    archived = home / "users" / ".archived"
    assert sorted(p.name for p in archived.iterdir()) == ["john", "john-1"]
    assert [p.name for p in (archived / "john").iterdir()] == ["20261116T040506Z"]


def test_box_profile_homes_lists_default_then_profiles(root: Path) -> None:
    (root / "profiles" / "Not_Valid").mkdir()
    (root / "profiles" / "afile").write_text("x")
    assert upd.box_profile_homes() == [
        root,
        root / "profiles" / "cfo",
        root / "profiles" / "cmo",
    ]


def test_schema_resolves_to_its_own_profile_home_whatever_the_hint(root: Path) -> None:
    cfo, cmo = root / "profiles" / "cfo", root / "profiles" / "cmo"
    assert upd.profile_home_for_schema("app_prod", "prod") == root
    assert upd.profile_home_for_schema("app_prod_cmo", "prod", hint=cfo) == cmo
    assert upd.profile_home_for_schema("app_prod_cfo", "prod", hint=cfo) == cfo
    assert upd.profile_home_for_schema("app_prod_nobody", "prod") is None


def test_sync_skips_dev_and_unknown_schemas(root: Path) -> None:
    assert (
        upd.sync_user_profile_dir("john", active=True, schema="app_dev", mode="dev")
        is None
    )
    assert (
        upd.sync_user_profile_dir("john", active=True, schema="app_prod_x", mode="prod")
        is None
    )
    assert not (root / "users").exists()


def test_principal_store_hook_targets_the_schema_profile_not_the_process(
    root: Path,
) -> None:
    """The process runs as default; a store on CMO's schema writes under CMO."""
    store = PrincipalStore(SupabaseAppStore("prod", "app_prod_cmo", "postgresql://x"))
    store._sync_user_dir("john", active=True)
    assert (root / "profiles" / "cmo" / "users" / "john").is_dir()
    assert not (root / "users").exists()
    assert not (root / "profiles" / "cfo" / "users").exists()

    store._sync_user_dir("john", active=False)
    assert not (root / "profiles" / "cmo" / "users" / "john").exists()
    assert (
        len(
            list((root / "profiles" / "cmo" / "users" / ".archived" / "john").iterdir())
        )
        == 1
    )


def test_hook_failures_are_logged_not_raised(
    root: Path, caplog: pytest.LogCaptureFixture
) -> None:
    home = root / "profiles" / "cfo"
    (home / "users").write_text("not a dir")
    assert (
        upd.sync_user_profile_dir(
            "john", active=True, schema="app_prod_cfo", mode="prod"
        )
        is None
    )
    assert "Could not create the user folder" in caplog.text


def test_backfill_skips_core_only_profiles(root: Path) -> None:
    reports = asyncio.run(upd.backfill_user_profile_dirs(config={}))
    assert [r.home for r in reports] == upd.box_profile_homes()
    assert all(r.skipped == "no app datastore configured" for r in reports)
    assert not any((home / "users").exists() for home in upd.box_profile_homes())


def test_backfill_cli_prints_per_profile(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import argparse

    from hermes_cli import member

    seen: dict[str, object] = {}

    async def fake(*, dry_run: bool = False):
        seen["dry_run"] = dry_run
        return [
            upd.ProfileBackfill(home=root, created=["john"], existing=["leo"]),
            upd.ProfileBackfill(home=root / "profiles" / "cfo", skipped="core-only"),
        ]

    monkeypatch.setattr(upd, "backfill_user_profile_dirs", fake)
    parser = argparse.ArgumentParser()
    member.register_member_subparser(parser.add_subparsers())
    args = parser.parse_args(["member", "backfill-folders", "--dry-run"])
    assert args.func(args) == 0
    out = capsys.readouterr().out
    assert seen["dry_run"] is True
    assert "would create 1, already present 1" in out
    assert "+ users/john/" in out
    assert "skipped (core-only)" in out
    assert os.path.exists(root)
