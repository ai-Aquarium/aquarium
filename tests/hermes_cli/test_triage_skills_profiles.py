"""FG-03 P3 — triage skills across the profile lifecycle.

``--clone`` / ``--clone-all`` / export carry the profile's own
``triage-skills/`` (the template) but never ``users/`` (each person's
version), and agent skill discovery never loads triage skill files.
"""

from __future__ import annotations

import json
import tarfile
from pathlib import Path

import pytest

import hermes_cli.profiles as profiles
from hermes_cli import triage_skills as tsk

KEY = "email-triage/classify-emails.md"


@pytest.fixture()
def default_home(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(tsk, "kind_config", lambda kind: (tmp_path / "none.json", {
        "triage": {"skills_dirs": [str(tmp_path / "no-box-folders")]}}))
    tsk.write_file("email", "template", KEY, "CFO classify", home=home, author="leo")
    tsk.write_care("email", "CFO cares", layer="template", home=home, author="leo")
    tsk.write_file("email", "user", KEY, "John classify", home=home, user_id="john", author="john")
    tsk.write_care("email", "John cares", layer="user", home=home, user_id="john", author="john")
    return home


def test_dirname_matches_the_module():
    assert profiles._TRIAGE_SKILLS_DIRNAME == tsk.TRIAGE_SKILLS_DIRNAME


def _assert_template_only(clone: Path) -> None:
    assert tsk.resolve("email", clone)[0].key  # resolves at all
    view = {f.key: f for f in tsk.resolve("email", clone, "john")}
    assert view[KEY].content == "CFO classify"
    assert view[KEY].layer == "template"
    assert tsk.care_section("email", clone, "john") == {"layer": "template", "content": "CFO cares"}
    assert not (clone / "users").exists()


def test_clone_copies_the_template_without_history_or_users(default_home):
    clone = profiles.create_profile("cfo2", clone_config=True, no_alias=True)
    _assert_template_only(clone)
    assert not list((clone / tsk.TRIAGE_SKILLS_DIRNAME).rglob(".versions"))
    # The clone's first edit starts its own history from the copied text.
    tsk.write_file("email", "template", KEY, "new", home=clone, author="cfo2_owner")
    assert [h["action"] for h in tsk.history("email", "template", KEY, clone)] == ["edit", "baseline"]


def test_clone_all_copies_the_template_never_users(default_home):
    clone = profiles.create_profile("cfo3", clone_all=True, no_alias=True)
    _assert_template_only(clone)


@pytest.mark.parametrize("named", [False, True])
def test_export_carries_the_template_never_users(default_home, tmp_path, named):
    name = "default"
    if named:
        name = "cfo4"
        source = profiles.create_profile(name, clone_all=True, no_alias=True)
        tsk.write_care("email", "John@cfo4", layer="user", home=source, user_id="john", author="john")
    archive = profiles.export_profile(name, str(tmp_path / f"{name}.tar.gz"))
    with tarfile.open(archive) as tf:
        names = tf.getnames()
    assert f"{name}/triage-skills/email/{KEY}" in names
    assert f"{name}/triage-skills/email/{tsk.CARE_KEY}" in names
    assert not [n for n in names if n.split("/")[1:2] == ["users"]]


def test_skill_discovery_never_loads_triage_skills(default_home, monkeypatch):
    # A SKILL.md-shaped file in the template must stay invisible to the agent.
    tsk.write_file("email", "template", "email-triage/SKILL.md",
                   "---\nname: triage-leak\ndescription: x\n---\nbody", home=default_home, author="leo")
    skills = default_home / "skills" / "real-skill"
    skills.mkdir(parents=True)
    (skills / "SKILL.md").write_text("---\nname: real-skill\ndescription: ok\n---\nbody")

    from agent import skill_utils
    from tools import skills_tool

    monkeypatch.setattr(skills_tool, "SKILLS_DIR", default_home / "skills")
    triage = (default_home / tsk.TRIAGE_SKILLS_DIRNAME).resolve()
    for d in skill_utils.get_all_skills_dirs():
        assert not triage.is_relative_to(Path(d).resolve())
    names = {s["name"] for s in skills_tool._find_all_skills(skip_disabled=True)}
    assert "real-skill" in names and "triage-leak" not in names
    for name in ("triage-leak", "classify-emails"):
        out = json.loads(skills_tool.skill_view(name))
        assert not out.get("success"), out
