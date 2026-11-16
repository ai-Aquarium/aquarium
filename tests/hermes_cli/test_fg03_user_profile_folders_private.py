"""FG-03 P1: a person's own profile folder stays theirs and goes with them.

Each person enrolled in a profile gets ``<profile home>/users/<uid>/`` — their
own version of the profile's settings — and archived copies under
``users/.archived/<uid>/<timestamp>/``. Two promises follow:

* the profile is a template: cloning, exporting or importing it hands over
  the profile, never anybody's own version of it;
* removing a person from the box removes their folders in every profile, and
  nobody else's.

And nothing under ``users/`` is the profile's skill, so scanning a profile
home never picks one up.

Run against a real temporary hermes root with the default profile and two
named profiles: every claim is about what is on disk.
"""

from __future__ import annotations

import tarfile
from pathlib import Path

import pytest

from hermes_cli.profiles import create_profile, export_profile, import_profile

PEOPLE = ("john", "mary")


def _populate(home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text("model: template\n")
    (home / "skills" / "shared").mkdir(parents=True, exist_ok=True)
    (home / "skills" / "shared" / "SKILL.md").write_text(
        "---\nname: shared\ndescription: the profile's own skill\n---\n"
    )
    for uid in PEOPLE:
        own = home / "users" / uid
        (own / "skills" / f"{uid}-triage").mkdir(parents=True)
        (own / "skills" / f"{uid}-triage" / "SKILL.md").write_text(
            f"---\nname: {uid}-triage\ndescription: {uid}'s own\n---\n"
        )
        (own / "settings.yaml").write_text(f"owner: {uid}\n")
        archived = home / "users" / ".archived" / uid / "20261101T000000Z"
        archived.mkdir(parents=True)
        (archived / "settings.yaml").write_text(f"old {uid}\n")
        (home / "memories" / "users" / uid).mkdir(parents=True, exist_ok=True)
        (home / "memories" / "users" / uid / "MEMORY.md").write_text(f"about {uid}")


@pytest.fixture()
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """``~/.hermes`` with the default profile plus ``alpha`` and ``beta``."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    root = tmp_path / ".hermes"
    for home in (root, root / "profiles" / "alpha", root / "profiles" / "beta"):
        _populate(home)
    for uid in PEOPLE:
        (root / "persons" / uid).mkdir(parents=True)
        (root / "persons" / uid / "USER.md").write_text(f"who {uid} is")
    monkeypatch.setenv("HERMES_HOME", str(root))
    return root


def _homes(root: Path) -> list[Path]:
    return [root, root / "profiles" / "alpha", root / "profiles" / "beta"]


def _archive_names(archive: Path) -> list[str]:
    with tarfile.open(archive) as tf:
        return tf.getnames()


# ---------------------------------------------------------------------------
# The profile travels; people's own versions of it do not
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("clone_all", [False, True])
def test_a_clone_gets_the_template_and_nobodys_own_folder(
    box: Path, clone_all: bool
) -> None:
    clone = create_profile(
        "gamma",
        clone_from="alpha",
        clone_all=clone_all,
        no_alias=True,
        verify_datastore=False,
    )

    assert (clone / "skills" / "shared" / "SKILL.md").is_file()
    assert not (clone / "users").exists()


@pytest.mark.parametrize("profile", ["default", "alpha"])
def test_an_export_carries_the_profile_without_peoples_folders(
    box: Path, tmp_path: Path, profile: str
) -> None:
    archive = export_profile(profile, str(tmp_path / f"{profile}.tar.gz"))

    names = _archive_names(archive)
    assert any(n.endswith("skills/shared/SKILL.md") for n in names)
    assert not [n for n in names if "/users/" in f"/{n}/" and "memories" not in n]


def test_an_import_from_an_old_archive_drops_peoples_folders(
    box: Path, tmp_path: Path
) -> None:
    """An archive written before this exporter can still carry ``users/``."""
    staged = tmp_path / "staged" / "legacy"
    _populate(staged)
    archive = tmp_path / "legacy.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.add(staged, arcname="legacy")
    assert any("/users/john/" in n for n in _archive_names(archive))

    imported = import_profile(str(archive), "legacy", verify_datastore=False)

    assert (imported / "skills" / "shared" / "SKILL.md").is_file()
    assert not (imported / "users").exists()


def test_a_distribution_install_never_ships_or_replaces_peoples_folders() -> None:
    from hermes_cli.profile_distribution import USER_OWNED_EXCLUDE

    assert "users" in USER_OWNED_EXCLUDE


# ---------------------------------------------------------------------------
# Removing a person from the box
# ---------------------------------------------------------------------------


def _remove_from(home: Path, uid: str, monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.members import _erase_person_files

    monkeypatch.setenv("HERMES_HOME", str(home))
    return _erase_person_files(uid)


def test_removing_john_everywhere_removes_his_folders_and_leaves_marys(
    box: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    removed: list[str] = []
    for home in _homes(box):
        removed += _remove_from(home, "john", monkeypatch)[1]

    for home in _homes(box):
        assert not (home / "users" / "john").exists()
        assert not (home / "users" / ".archived" / "john").exists()
        assert (home / "users" / "mary" / "settings.yaml").is_file()
        assert (home / "users" / ".archived" / "mary").is_dir()
    assert not (box / "persons" / "john").exists()
    assert (box / "persons" / "mary").is_dir()
    assert {Path(p) for p in removed} == {
        path
        for home in _homes(box)
        for path in (home / "users" / "john", home / "users" / ".archived" / "john")
    }


def test_removal_from_one_profile_leaves_his_folders_in_the_others(
    box: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    alpha, beta = box / "profiles" / "alpha", box / "profiles" / "beta"

    _, removed = _remove_from(alpha, "john", monkeypatch)

    assert {Path(p) for p in removed} == {
        alpha / "users" / "john",
        alpha / "users" / ".archived" / "john",
    }
    assert (beta / "users" / "john" / "settings.yaml").is_file()
    assert (box / "users" / ".archived" / "john").is_dir()


def test_last_removal_sweeps_archives_left_by_profiles_he_already_left(
    box: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Leaving ``beta`` earlier archived his folder there and dropped his notes;
    when he leaves his last profile, that archive goes too."""
    import shutil

    beta = box / "profiles" / "beta"
    shutil.rmtree(beta / "users" / "john")
    shutil.rmtree(beta / "memories" / "users" / "john")

    _remove_from(box / "profiles" / "alpha", "john", monkeypatch)
    assert (beta / "users" / ".archived" / "john").is_dir()

    _, removed = _remove_from(box, "john", monkeypatch)

    assert str(beta / "users" / ".archived" / "john") in removed
    assert not (beta / "users" / ".archived" / "john").exists()
    assert (beta / "users" / ".archived" / "mary").is_dir()


def test_the_box_inventory_names_each_folder_for_a_human(box: Path) -> None:
    from tools.memory_tool import USER_FOLDER_SCOPES, person_memory_files_on_box

    folders = {
        c.path: c.label
        for c in person_memory_files_on_box("john")
        if c.scope in USER_FOLDER_SCOPES
    }

    assert folders[box / "users" / "john"] == "john's own folder in profile default"
    assert (
        folders[box / "profiles" / "beta" / "users" / ".archived" / "john"]
        == "john's archived folders in profile beta"
    )
    assert not [p for p in folders if "mary" in p.parts]


# ---------------------------------------------------------------------------
# Skill discovery
# ---------------------------------------------------------------------------


def test_a_scan_of_a_profile_home_skips_peoples_folders(box: Path) -> None:
    from agent.skill_utils import iter_skill_index_files

    for home in _homes(box):
        found = list(iter_skill_index_files(home, "SKILL.md"))
        assert home / "skills" / "shared" / "SKILL.md" in found
        assert not [p for p in found if "users" in p.relative_to(home).parts]


def test_a_skills_tree_with_its_own_users_dir_is_still_scanned(box: Path) -> None:
    """Only a profile home's ``users/`` is private; a skill category of that
    name elsewhere is an ordinary skill folder."""
    from agent.skill_utils import iter_skill_index_files

    skill = box / "skills" / "users" / "onboard" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: onboard\ndescription: d\n---\n")

    assert skill in list(iter_skill_index_files(box / "skills", "SKILL.md"))


def test_an_external_skills_dir_inside_peoples_folders_is_ignored(box: Path) -> None:
    from agent.skill_utils import get_external_skills_dirs

    private = box / "profiles" / "alpha" / "users" / "john" / "skills"
    elsewhere = box.parent / "team-skills"
    elsewhere.mkdir()
    (box / "config.yaml").write_text(
        f"skills:\n  external_dirs:\n    - {private}\n    - {elsewhere}\n"
    )

    dirs = get_external_skills_dirs()

    assert elsewhere.resolve() in [d.resolve() for d in dirs]
    assert private.resolve() not in [d.resolve() for d in dirs]
