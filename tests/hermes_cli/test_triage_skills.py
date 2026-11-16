"""FG-03 P3 — layered triage skills per user-profile (``hermes_cli.triage_skills``).

Real files under a tmp profile home and a tmp box skills folder; no mocks
beyond pointing the built-in layer at that folder.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import hermes_cli.triage_skills as tsk
from hermes_cli.triage_status import MAX_SKILL_FILE_BYTES, SkillFileError

REPO = Path(tsk.__file__).resolve().parent.parent


@pytest.fixture
def box(tmp_path, monkeypatch):
    """Box-wide built-in folders laid out like ``/opt/data/skills``."""
    skills = tmp_path / "box-skills"
    wa, em = skills / "whatsapp-triage", skills / "email-triage"
    (em / "custom").mkdir(parents=True)
    wa.mkdir(parents=True)
    (wa / "classify-messages.md").write_text("WA classify\n")
    (wa / "escalation-rules.md").write_text("WA escalate\n")
    (em / "classify-emails.md").write_text("EM classify\n")
    (em / "escalation-rules.md").write_text("EM escalate\n")
    (em / "custom" / "vip.md").write_text("EM vip\n")
    config = {"triage": {"skills_dirs": [str(wa), str(em)]}}
    monkeypatch.setattr(tsk, "kind_config", lambda kind: (tmp_path / "cfg.json", config))
    home = tmp_path / "home"
    home.mkdir()
    return SimpleNamespace(home=home, wa=wa, em=em, config=config, tmp=tmp_path)


def _view(box, user_id=None, kind="email"):
    return {f.key: f for f in tsk.resolve(kind, box.home, user_id)}


def _put(root: Path, rel: str, text: str = "") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


# -- layers ---------------------------------------------------------------------


def test_email_builtins_read_both_folders_in_load_skills_order(box):
    keys = [k for k, _ in tsk.builtin_files("email")]
    assert keys == [
        "whatsapp-triage/classify-messages.md",
        "whatsapp-triage/escalation-rules.md",
        "email-triage/classify-emails.md",
        "email-triage/escalation-rules.md",
        "email-triage/custom/vip.md",
    ]
    # Same basename in two folders never collides.
    view = _view(box)
    assert view["whatsapp-triage/escalation-rules.md"].content == "WA escalate\n"
    assert view["email-triage/escalation-rules.md"].content == "EM escalate\n"
    assert all(f.layer == "builtin" for f in view.values())


def test_builtin_fallback_is_the_shipped_folders_email_includes_whatsapp(box, monkeypatch):
    monkeypatch.setattr(tsk, "kind_config", lambda kind: (box.tmp / "cfg.json", {
        "triage": {"skills_dirs": [str(box.tmp / "missing")]}}))
    email = {k.split("/")[0] for k, _ in tsk.builtin_files("email")}
    assert email == {"whatsapp-triage", "email-triage"}
    assert {k.split("/")[0] for k, _ in tsk.builtin_files("whatsapp")} == {"whatsapp-triage"}
    for key, path in tsk.builtin_files("email"):
        assert path == REPO / "custom" / "skills" / key


def test_template_overrides_and_user_overrides_template(box):
    key = "email-triage/classify-emails.md"
    tdir = tsk.template_dir("email", box.home)
    udir = tsk.user_dir("email", box.home, "john")
    _put(tdir, key, "CFO classify\n")
    assert _view(box)[key].layer == "template"
    assert _view(box, "john")[key].content == "CFO classify\n"
    _put(udir, key, "John classify\n")
    f = _view(box, "john")[key]
    assert (f.layer, f.content) == ("user", "John classify\n")
    assert f.layers_present == {"builtin": "content", "template": "content", "user": "content"}
    # Mary and the template view still see the template.
    assert _view(box, "mary")[key].content == "CFO classify\n"
    assert _view(box)[key].content == "CFO classify\n"


def test_added_keys_follow_builtins_sorted(box):
    _put(tsk.template_dir("email", box.home), "zeta.md", "z")
    _put(tsk.user_dir("email", box.home, "john"), "alpha.md", "a")
    keys = list(_view(box, "john"))
    assert keys[-2:] == ["alpha.md", "zeta.md"]
    assert keys[:5] == [k for k, _ in tsk.builtin_files("email")]
    assert "alpha.md" not in _view(box)  # the template view has no user keys


def test_disable_marker_beats_content_in_the_same_layer(box):
    key = "email-triage/classify-emails.md"
    udir = tsk.user_dir("email", box.home, "john")
    _put(udir, key, "mine")
    _put(udir, key + tsk.DISABLED_SUFFIX)
    f = _view(box, "john")[key]
    assert f.disabled and f.layer is None and f.content is None
    assert f.layers_present["user"] == "disabled"


def test_user_content_reenables_a_template_disabled_key(box):
    key = "email-triage/custom/vip.md"
    _put(tsk.template_dir("email", box.home), key + tsk.DISABLED_SUFFIX)
    assert _view(box, "john")[key].disabled
    _put(tsk.user_dir("email", box.home, "john"), key, "John vip")
    assert _view(box, "john")[key].content == "John vip"


def test_unsafe_files_in_a_layer_are_ignored(box, tmp_path):
    tdir = tsk.template_dir("email", box.home)
    _put(tdir, ".hidden.md", "x")
    _put(tdir, "notes.txt", "x")
    _put(tdir, "a/b/c/d.md", "too deep")
    _put(tdir, tsk.CARE_KEY, "care is not a skill")
    outside = _put(tmp_path, "outside.md", "secret")
    os.symlink(outside, tdir / "link.md")
    keys = set(_view(box))
    assert not keys & {".hidden.md", "notes.txt", "a/b/c/d.md", tsk.CARE_KEY, "link.md"}


# -- writing ------------------------------------------------------------------------


def test_write_file_override_add_and_history_baseline(box):
    key = "email-triage/classify-emails.md"
    v1 = tsk.write_file("email", "user", key, "mine v1", home=box.home, user_id="john",
                        author="john", config=box.config)
    v2 = tsk.write_file("email", "user", key, "mine v2", home=box.home, user_id="john",
                        author="john", config=box.config)
    hist = tsk.history("email", "user", key, box.home, "john")
    assert [h["action"] for h in hist] == ["edit", "edit", "baseline"]  # newest first
    assert [h["content"] for h in hist] == ["mine v2", "mine v1", "EM classify\n"]
    assert hist[-1]["author"] == "system"
    assert [h["id"] for h in hist[:2]] == [v2["id"], v1["id"]]
    assert _view(box, "john")[key].content == "mine v2"
    # A brand-new key has nothing before it: no baseline.
    tsk.write_file("email", "template", "new.md", "added", home=box.home, author="leo")
    assert [h["action"] for h in tsk.history("email", "template", "new.md", box.home)] == ["edit"]


def test_user_baseline_is_the_template_version(box):
    key = "email-triage/classify-emails.md"
    tsk.write_file("email", "template", key, "CFO", home=box.home, author="leo")
    tsk.write_file("email", "user", key, "John", home=box.home, user_id="john", author="john")
    base = tsk.history("email", "user", key, box.home, "john")[-1]
    assert (base["action"], base["content"]) == ("baseline", "CFO")


def test_write_file_clears_its_layer_marker_and_size_cap(box):
    key = "email-triage/classify-emails.md"
    tsk.set_disabled("email", "user", key, True, home=box.home, user_id="john", author="john")
    assert _view(box, "john")[key].disabled
    tsk.write_file("email", "user", key, "back", home=box.home, user_id="john", author="john")
    assert _view(box, "john")[key].content == "back"
    with pytest.raises(SkillFileError) as exc:
        tsk.write_file("email", "user", key, "x" * (MAX_SKILL_FILE_BYTES + 1), home=box.home,
                       user_id="john", author="john")
    assert exc.value.status == 413


def test_disable_enable_and_noops(box):
    key = "whatsapp-triage/classify-messages.md"
    kw = dict(home=box.home, user_id="john", author="john")
    tsk.set_disabled("email", "user", key, True, **kw)
    assert tsk.set_disabled("email", "user", key, True, **kw)["noop"]
    assert _view(box, "john")[key].disabled
    assert not _view(box)[key].disabled
    tsk.set_disabled("email", "user", key, False, **kw)
    assert not _view(box, "john")[key].disabled
    assert tsk.set_disabled("email", "user", key, False, **kw)["noop"]
    actions = [h["action"] for h in tsk.history("email", "user", key, box.home, "john")]
    assert actions == ["enable", "disable"]
    with pytest.raises(SkillFileError) as exc:
        tsk.set_disabled("email", "user", "nope.md", True, **kw)
    assert exc.value.status == 404


def test_enabling_a_key_the_template_turned_off_is_refused(box):
    key = "email-triage/classify-emails.md"
    tsk.set_disabled("email", "template", key, True, home=box.home, author="leo")
    kw = dict(home=box.home, user_id="john", author="john")
    with pytest.raises(SkillFileError) as exc:
        tsk.set_disabled("email", "user", key, False, **kw)
    assert exc.value.status == 409
    # Same when John also has his own marker: removing it would leave it off.
    tsk.set_disabled("email", "user", key, True, **kw)
    with pytest.raises(SkillFileError) as exc:
        tsk.set_disabled("email", "user", key, False, **kw)
    assert exc.value.status == 409
    # His own text turns it back on for him only.
    tsk.write_file("email", "user", key, "mine", **kw)
    assert _view(box, "john")[key].content == "mine"
    assert _view(box, "mary")[key].disabled


def test_reset_file_and_reset_all(box):
    kw = dict(home=box.home, user_id="john", author="john")
    a, b = "email-triage/classify-emails.md", "whatsapp-triage/escalation-rules.md"
    tsk.write_file("email", "template", a, "CFO", home=box.home, author="leo")
    tsk.write_file("email", "user", a, "John", **kw)
    tsk.set_disabled("email", "user", b, True, **kw)
    tsk.write_file("email", "user", "added.md", "mine", **kw)
    tsk.write_care("email", "John cares", layer="user", **kw)

    assert tsk.reset_file("email", a, **kw)["action"] == "reset"
    assert _view(box, "john")[a].content == "CFO"
    assert tsk.reset_file("email", a, **kw)["noop"]
    assert tsk.history("email", "user", a, box.home, "john")[0]["action"] == "reset"

    done = tsk.reset_all("email", **kw)
    assert sorted(done) == sorted([b, "added.md", tsk.CARE_KEY])
    view = _view(box, "john")
    assert not view[b].disabled and "added.md" not in view
    assert tsk.care_section("email", box.home, "john")["layer"] == "builtin"
    assert tsk.reset_all("email", **kw) == []
    # The template is untouched.
    assert _view(box)[a].content == "CFO"


def test_failed_change_rolls_back_the_history_record(box, monkeypatch):
    key = "email-triage/classify-emails.md"
    kw = dict(home=box.home, user_id="john", author="john")
    tsk.write_file("email", "user", key, "v1", **kw)

    def boom(file, content):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(tsk, "_atomic_write", boom)
    with pytest.raises(SkillFileError) as exc:
        tsk.write_file("email", "user", key, "v2", **kw)
    assert exc.value.status == 500
    assert [h["content"] for h in tsk.history("email", "user", key, box.home, "john")] == [
        "v1", "EM classify\n"]


def test_a_corrupt_history_line_does_not_add_a_second_baseline(box):
    key = "email-triage/classify-emails.md"
    kw = dict(home=box.home, user_id="john", author="john")
    tsk.write_file("email", "user", key, "v1", **kw)
    hist = tsk.user_dir("email", box.home, "john") / ".versions" / "email-triage__classify-emails.md.jsonl"
    with hist.open("a") as fh:
        fh.write("{not json\n")
    tsk.write_file("email", "user", key, "v2", **kw)
    actions = [h["action"] for h in tsk.history("email", "user", key, box.home, "john")]
    assert actions == ["edit", "edit", "baseline"]


# -- "What I care about" -------------------------------------------------------------


def test_care_resolves_user_then_template_then_builtin(box):
    shipped = (REPO / "custom/skills/triage-care/email.md").read_text()
    assert tsk.care_section("email", box.home, "john") == {"layer": "builtin", "content": shipped}
    tsk.write_care("email", "CFO cares", layer="template", home=box.home, author="leo")
    assert tsk.care_section("email", box.home, "john") == {"layer": "template", "content": "CFO cares"}
    tsk.write_care("email", "John cares", layer="user", home=box.home, user_id="john", author="john")
    assert tsk.care_section("email", box.home, "john")["content"] == "John cares"
    assert tsk.care_section("email", box.home, "mary")["content"] == "CFO cares"
    assert tsk.care_section("email", box.home)["content"] == "CFO cares"
    # Kinds are separate.
    assert tsk.care_section("whatsapp", box.home, "john")["layer"] == "builtin"
    hist = tsk.history("email", "user", tsk.CARE_KEY, box.home, "john")
    assert [(h["action"], h["content"]) for h in hist] == [("edit", "John cares"), ("baseline", "CFO cares")]


def test_care_refuses_empty_and_over_4kb(box):
    kw = dict(layer="user", home=box.home, user_id="john", author="john")
    for empty in ("", "   \n\t"):
        with pytest.raises(SkillFileError) as exc:
            tsk.write_care("email", empty, **kw)
        assert exc.value.status == 422
    tsk.write_care("email", "é" * (tsk.MAX_CARE_BYTES // 2), **kw)  # exactly 4 KB of UTF-8
    with pytest.raises(SkillFileError) as exc:
        tsk.write_care("email", "x" * (tsk.MAX_CARE_BYTES + 1), **kw)
    assert exc.value.status == 413


def test_care_ignores_a_blank_or_symlinked_file(box, tmp_path):
    udir = tsk.user_dir("email", box.home, "john")
    _put(udir, tsk.CARE_KEY, "  \n")
    assert tsk.care_section("email", box.home, "john")["layer"] == "builtin"
    (udir / tsk.CARE_KEY).unlink()
    os.symlink(_put(tmp_path, "mary-care.md", "Mary's secret"), udir / tsk.CARE_KEY)
    assert tsk.care_section("email", box.home, "john")["layer"] == "builtin"


def test_care_key_is_not_writable_as_a_skill_file(box):
    for call in (
        lambda: tsk.write_file("email", "user", tsk.CARE_KEY, "", home=box.home,
                               user_id="john", author="john"),
        lambda: tsk.set_disabled("email", "user", tsk.CARE_KEY, True, home=box.home,
                                 user_id="john", author="john"),
        lambda: tsk.reset_file("email", tsk.CARE_KEY, home=box.home, user_id="john", author="john"),
    ):
        with pytest.raises(SkillFileError) as exc:
            call()
        assert exc.value.status == 400
    assert tsk.care_section("email", box.home, "john")["layer"] == "builtin"


# -- diff / layer_content ---------------------------------------------------------------


def test_diff_and_layer_content(box):
    key = "email-triage/classify-emails.md"
    kw = dict(home=box.home, user_id="john", author="john")
    same = tsk.diff("email", key, box.home, "john")
    assert not same["changed"] and same["diff"] == ""
    tsk.write_file("email", "user", key, "John classify\n", **kw)
    d = tsk.diff("email", key, box.home, "john")
    assert d["changed"]
    assert "-EM classify" in d["diff"] and "+John classify" in d["diff"]
    assert "--- template/" + key in d["diff"]
    tsk.set_disabled("email", "user", "email-triage/escalation-rules.md", True, **kw)
    off = tsk.diff("email", "email-triage/escalation-rules.md", box.home, "john")
    assert off["changed"] and off["mine_disabled"] and not off["template_disabled"]
    added = tsk.write_file("email", "user", "mine.md", "x\n", **kw)
    assert added and tsk.diff("email", "mine.md", box.home, "john")["changed"]
    with pytest.raises(SkillFileError) as exc:
        tsk.diff("email", "nothing.md", box.home, "john")
    assert exc.value.status == 404

    assert tsk.layer_content("email", "builtin", key, box.home) == "EM classify\n"
    assert tsk.layer_content("email", "template", key, box.home) is None
    assert tsk.layer_content("email", "user", key, box.home, "john") == "John classify\n"
    assert tsk.layer_content("email", "user", "email-triage/escalation-rules.md", box.home, "john") is None


# -- keys and containment ---------------------------------------------------------------


@pytest.mark.parametrize("key", [
    "", "a", "a.txt", "../a.md", "a/../b.md", "/abs.md", ".hidden.md", "a/.x/b.md",
    ".versions/a.md", "a/b/c/d.md", "a//b.md", "a\\b.md", "-x.md", tsk.CARE_KEY, None,
])
def test_validate_key_refuses(key):
    with pytest.raises(SkillFileError) as exc:
        tsk.validate_key(key)
    assert exc.value.status == 400


@pytest.mark.parametrize("key", ["a.md", "email-triage/x.md", "email-triage/custom/x_1.md"])
def test_validate_key_accepts(key):
    assert tsk.validate_key(key) == key


def test_unknown_kind_and_bad_user_id(box):
    with pytest.raises(SkillFileError) as exc:
        tsk.resolve("sms", box.home)
    assert exc.value.status == 404
    for bad in ("../mary", "a/b", ""):
        with pytest.raises(SkillFileError) as exc:
            tsk.write_file("email", "user", "a.md", "x", home=box.home, user_id=bad, author="x")
        assert exc.value.status == 400
    with pytest.raises(SkillFileError):
        tsk.write_file("email", "builtin", "a.md", "x", home=box.home, author="x")


def test_symlinked_folder_inside_a_layer_cannot_write_outside(box, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    udir = tsk.user_dir("email", box.home, "john")
    udir.mkdir(parents=True)
    os.symlink(outside, udir / "email-triage")
    kw = dict(home=box.home, user_id="john", author="john")
    with pytest.raises(SkillFileError) as exc:
        tsk.write_file("email", "user", "email-triage/new.md", "x", **kw)
    assert exc.value.status == 400
    assert not list(outside.iterdir())


def test_symlinked_file_marker_or_history_cannot_escape(box, tmp_path):
    target = _put(tmp_path, "victim.txt", "keep me")
    udir = tsk.user_dir("email", box.home, "john")
    udir.mkdir(parents=True)
    kw = dict(home=box.home, user_id="john", author="john")
    key = "email-triage/classify-emails.md"

    (udir / "email-triage").mkdir()
    os.symlink(target, udir / (key + tsk.DISABLED_SUFFIX))
    with pytest.raises(SkillFileError):
        tsk.set_disabled("email", "user", key, True, **kw)
    (udir / (key + tsk.DISABLED_SUFFIX)).unlink()

    os.symlink(target, udir / key)
    for call in (
        lambda: tsk.write_file("email", "user", key, "x", **kw),
        lambda: tsk.layer_content("email", "user", key, box.home, "john"),
    ):
        with pytest.raises(SkillFileError):
            call()
    (udir / key).unlink()

    os.symlink(tmp_path, udir / ".versions")
    with pytest.raises(SkillFileError):
        tsk.write_file("email", "user", key, "x", **kw)
    assert target.read_text() == "keep me"
    assert not list(tmp_path.glob("*.jsonl"))


def test_a_symlinked_user_layer_folder_is_refused(box, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    users = box.home / "users" / "john"
    users.mkdir(parents=True)
    os.symlink(elsewhere, users / tsk.TRIAGE_SKILLS_DIRNAME)
    with pytest.raises(SkillFileError):
        tsk.write_care("email", "x", layer="user", home=box.home, user_id="john", author="john")
    assert not list(elsewhere.rglob("*"))


def _pipeline_load_skills():
    """The email pipeline's own ``load_skills`` (the module itself needs the box)."""
    import ast
    import glob

    source = (REPO / "custom/email/email_triage_agent.py").read_text()
    fn = next(n for n in ast.parse(source).body
              if isinstance(n, ast.FunctionDef) and n.name == "load_skills")
    scope = {"os": os, "glob": glob, "_email_config": None,
             "WA_SKILLS_DIR": None, "EMAIL_SKILLS_DIR": None}
    exec(compile(ast.Module([fn], []), "load_skills", "exec"), scope)
    return scope["load_skills"]


# -- compose_prompt -----------------------------------------------------------------------


def test_compose_prompt_matches_load_skills_format_and_is_byte_stable(box):
    first = tsk.compose_prompt("email", box.home, "john")
    assert first == tsk.compose_prompt("email", box.home, "john")
    blocks = first.split("\n\n---\n\n")
    assert [b.split("\n", 1)[0] for b in blocks] == [
        "## Skill: classify-messages.md", "## Skill: escalation-rules.md",
        "## Skill: classify-emails.md", "## Skill: escalation-rules.md",
        "## Skill: vip.md", f"## Skill: {tsk.CARE_KEY}",
    ]
    assert blocks[0] == "## Skill: classify-messages.md\nWA classify\n"
    # Same as today's pipeline when no layer exists (care section aside).
    expected = _pipeline_load_skills()("email", config=box.config)
    assert "\n\n---\n\n".join(blocks[:-1]) == expected


def test_compose_prompt_reflects_layers_and_ignores_file_mtimes(box):
    kw = dict(home=box.home, user_id="john", author="john")
    tsk.write_file("email", "user", "email-triage/classify-emails.md", "John\n", **kw)
    tsk.set_disabled("email", "user", "whatsapp-triage/classify-messages.md", True, **kw)
    tsk.write_file("email", "template", "house-rules.md", "CFO rules\n", home=box.home, author="leo")
    tsk.write_care("email", "John cares", layer="user", **kw)
    out = tsk.compose_prompt("email", box.home, "john")
    assert "WA classify" not in out
    assert "## Skill: classify-emails.md\nJohn\n" in out
    assert out.endswith(f"## Skill: house-rules.md\nCFO rules\n\n\n---\n\n## Skill: {tsk.CARE_KEY}\nJohn cares")
    for f in box.home.rglob("*.md"):
        os.utime(f, (1, 1))
    assert tsk.compose_prompt("email", box.home, "john") == out
    assert "John" not in tsk.compose_prompt("email", box.home, "mary")


# -- permissions -------------------------------------------------------------------------


def test_can_edit_layer():
    owner = SimpleNamespace(user_id="leo", role="owner", is_owner=True)
    admin = SimpleNamespace(user_id="ann", role="admin", is_owner=False)
    john = SimpleNamespace(user_id="john", role="member", is_owner=False)
    assert tsk.can_edit_layer("template", owner) and tsk.can_edit_layer("template", admin)
    assert not tsk.can_edit_layer("template", john)
    assert tsk.can_edit_layer("user", john, "john")
    assert not tsk.can_edit_layer("user", owner, "john")
    assert not tsk.can_edit_layer("builtin", owner)


def test_history_files_are_jsonl_in_the_layer_versions_folder(box):
    tsk.write_file("email", "template", "a.md", "x", home=box.home, author="leo")
    hist = tsk.template_dir("email", box.home) / ".versions" / "a.md.jsonl"
    rec = json.loads(hist.read_text().splitlines()[0])
    assert set(rec) == {"id", "at", "author", "action", "message", "content"}
