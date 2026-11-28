"""Tests for profile_skill_suggestions (LLM-scored "Could learn" list) and the
``needs_you.for_profile`` filter backing ``GET /api/needs-you?profile=``.
"""

from __future__ import annotations

import json as jsonlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import profiles as profiles_mod
from hermes_cli import profile_skill_suggestions as suggestions_mod


@pytest.fixture
def profile_env(tmp_path, monkeypatch):
    """Isolated HERMES_HOME standing in for a named profile's dir."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(profiles_mod, "profile_exists", lambda n: n == "myprof")
    monkeypatch.setattr(profiles_mod, "normalize_profile_name", lambda n: n)
    monkeypatch.setattr(profiles_mod, "get_profile_dir", lambda n: home)
    return home


def _library(entries):
    """A build_library()-shaped payload."""
    return {"profiles": ["myprof", "other"], "skills": entries}


def _entry(name, description="a skill", used_by=None, category=""):
    return {
        "name": name,
        "description": description,
        "category": category,
        "source": "profile",
        "owners": [],
        "used_by": used_by or [],
        "in_shared": False,
    }


def _patch_library(monkeypatch, entries):
    monkeypatch.setattr(
        "hermes_cli.skills_library.build_library", lambda: _library(entries)
    )


def _patch_installed(monkeypatch, names=None):
    monkeypatch.setattr(
        suggestions_mod, "_installed_names", lambda d: names or []
    )


def _fake_aux_response(content: str):
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    return resp


def _patch_aux_client(content: str):
    client = MagicMock()
    client.chat.completions.create = MagicMock(
        return_value=_fake_aux_response(content)
    )
    return patch(
        "agent.auxiliary_client.get_text_auxiliary_client",
        return_value=(client, "test-model"),
    ), client


def _aux_patches(content: str):
    client = MagicMock()
    client.chat.completions.create = MagicMock(
        return_value=_fake_aux_response(content)
    )
    return client


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------


def test_candidates_exclude_installed_skills(profile_env, monkeypatch):
    """A skill already installed (enabled OR disabled) is not suggested."""
    entries = [
        _entry("has-skill", used_by=[{"profile": "myprof", "enabled": True}]),
        _entry("off-skill", used_by=[{"profile": "myprof", "enabled": False}]),
        _entry("other-only", used_by=[{"profile": "other", "enabled": True}]),
        _entry("brand-new"),
    ]
    _patch_library(monkeypatch, entries)
    names = [c["name"] for c in suggestions_mod._candidates("myprof")]
    assert names == ["brand-new", "other-only"]


def test_suggest_empty_when_everything_installed(profile_env, monkeypatch):
    _patch_library(monkeypatch, [
        _entry("only", used_by=[{"profile": "myprof", "enabled": True}]),
    ])
    out = suggestions_mod.suggest_skills("myprof")
    assert out.ok and out.suggestions == []


# ---------------------------------------------------------------------------
# Scoring + parsing
# ---------------------------------------------------------------------------


def _score(profile_env, monkeypatch, entries, llm_content, **kwargs):
    _patch_library(monkeypatch, entries)
    _patch_installed(monkeypatch)
    client = _aux_patches(llm_content)
    with patch(
        "agent.auxiliary_client.get_text_auxiliary_client",
        return_value=(client, "test-model"),
    ), patch(
        "agent.auxiliary_client.get_auxiliary_extra_body", return_value={}
    ), patch(
        # Real resolve_task_timeout calls load_config(), which seeds a default
        # SOUL.md into HERMES_HOME mid-call and changes the context hash.
        "agent.auxiliary_client.resolve_task_timeout", return_value=60
    ):
        return suggestions_mod.suggest_skills("myprof", **kwargs), client


def test_scores_sorted_desc_and_enriched(profile_env, monkeypatch):
    entries = [_entry("low"), _entry("high"), _entry("mid")]
    payload = jsonlib.dumps([
        {"skill": "low", "score": 2, "reason": "weak fit"},
        {"skill": "high", "score": 9, "reason": "made for this"},
        {"skill": "mid", "score": 5, "reason": "generic"},
    ])
    out, _ = _score(profile_env, monkeypatch, entries, payload)
    assert out.ok, out.reason
    assert [s["skill"] for s in out.suggestions] == ["high", "mid", "low"]
    assert out.suggestions[0]["score"] == 9


def test_unknown_dupe_and_bad_rows_dropped(profile_env, monkeypatch):
    entries = [_entry("real-a"), _entry("real-b")]
    payload = jsonlib.dumps([
        {"skill": "hallucinated", "score": 9, "reason": "not real"},
        {"skill": "real-a", "score": 99, "reason": "clamped to 10"},
        {"skill": "real-a", "score": 3, "reason": "dupe dropped"},
        {"skill": "real-b", "score": "abc", "reason": "unparseable"},
        "junk",
    ])
    out, _ = _score(profile_env, monkeypatch, entries, payload)
    assert out.ok
    assert out.suggestions == [
        {"skill": "real-a", "score": 10, "reason": "clamped to 10",
         "description": "a skill", "category": ""}
    ]


def test_malformed_llm_response_fails_soft(profile_env, monkeypatch):
    out, _ = _score(
        profile_env, monkeypatch, [_entry("x")], "not json at all"
    )
    assert out.ok is False and "no usable scores" in out.reason


def test_no_aux_client_fails_soft(profile_env, monkeypatch):
    _patch_library(monkeypatch, [_entry("x")])
    _patch_installed(monkeypatch)
    with patch(
        "agent.auxiliary_client.get_text_auxiliary_client",
        return_value=(None, None),
    ), patch(
        "agent.auxiliary_client.get_auxiliary_extra_body", return_value={}
    ):
        out = suggestions_mod.suggest_skills("myprof")
    assert out.ok is False and "auxiliary" in out.reason


def test_missing_profile_fails_soft(profile_env, monkeypatch):
    monkeypatch.setattr(profiles_mod, "profile_exists", lambda n: False)
    out = suggestions_mod.suggest_skills("ghost")
    assert out.ok is False and "not found" in out.reason


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def test_second_call_serves_cache(profile_env, monkeypatch):
    entries = [_entry("a"), _entry("b")]
    payload = jsonlib.dumps([
        {"skill": "a", "score": 7, "reason": "r"},
        {"skill": "b", "score": 4, "reason": "r"},
    ])
    out1, client = _score(profile_env, monkeypatch, entries, payload)
    assert out1.ok and not out1.cached
    out2 = suggestions_mod.suggest_skills("myprof")
    assert out2.ok and out2.cached
    assert client.chat.completions.create.call_count == 1


def test_goal_change_invalidates_cache(profile_env, monkeypatch):
    entries = [_entry("a")]
    payload = jsonlib.dumps([{"skill": "a", "score": 5, "reason": "r"}])
    out1, _ = _score(profile_env, monkeypatch, entries, payload)
    assert out1.ok
    profiles_mod.write_profile_meta(profile_env, description="new goal")
    out2, client2 = _score(profile_env, monkeypatch, entries, payload)
    assert out2.ok and not out2.cached
    assert client2.chat.completions.create.call_count == 1


def test_new_library_entry_invalidates_cache(profile_env, monkeypatch):
    payload = jsonlib.dumps([{"skill": "a", "score": 5, "reason": "r"}])
    _score(profile_env, monkeypatch, [_entry("a")], payload)
    # A second LLM payload covering both entries this time.
    payload2 = jsonlib.dumps([
        {"skill": "a", "score": 5, "reason": "r"},
        {"skill": "b", "score": 8, "reason": "r"},
    ])
    out, _ = _score(
        profile_env, monkeypatch, [_entry("a"), _entry("b")], payload2
    )
    assert out.ok and not out.cached


def test_refresh_forces_rescore(profile_env, monkeypatch):
    payload = jsonlib.dumps([{"skill": "a", "score": 5, "reason": "r"}])
    _score(profile_env, monkeypatch, [_entry("a")], payload)
    out, client2 = _score(
        profile_env, monkeypatch, [_entry("a")], payload, refresh=True
    )
    assert out.ok and not out.cached
    assert client2.chat.completions.create.call_count == 1


# ---------------------------------------------------------------------------
# needs_you.for_profile
# ---------------------------------------------------------------------------


def test_for_profile_filters_by_context_profile():
    from hermes_cli import needs_you

    items = [
        {"id": "a", "context": {"profile": "storyteller-author"}},
        {"id": "b", "context": {"profile": "default"}},
        {"id": "c", "context": {}},
        {"id": "d", "context": {"profile": "storyteller-author"}},
    ]
    got = needs_you.for_profile(items, "storyteller-author")
    assert [i["id"] for i in got] == ["a", "d"]
    got = needs_you.for_profile(items, "default")
    assert [i["id"] for i in got] == ["b", "c"]


def test_for_profile_none_returns_everything():
    from hermes_cli import needs_you

    items = [{"id": "a", "context": {"profile": "x"}}, {"id": "b"}]
    assert [i["id"] for i in needs_you.for_profile(items, None)] == ["a", "b"]


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def api_client(monkeypatch, profile_env):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(
        hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db"
    )
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_skill_suggestions_endpoint(api_client, monkeypatch):
    _patch_library(monkeypatch, [_entry("a"), _entry("b")])
    _patch_installed(monkeypatch)
    payload = jsonlib.dumps([
        {"skill": "b", "score": 8, "reason": "fits"},
        {"skill": "a", "score": 3, "reason": "meh"},
    ])
    with patch(
        "agent.auxiliary_client.get_text_auxiliary_client",
        return_value=(_aux_patches(payload), "m"),
    ), patch(
        "agent.auxiliary_client.get_auxiliary_extra_body", return_value={}
    ):
        resp = api_client.get("/api/profiles/myprof/skill-suggestions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert [s["skill"] for s in body["suggestions"]] == ["b", "a"]


def test_skill_suggestions_endpoint_404_for_unknown_profile(
    api_client, monkeypatch
):
    monkeypatch.setattr(profiles_mod, "profile_exists", lambda n: False)
    resp = api_client.get("/api/profiles/ghost/skill-suggestions")
    assert resp.status_code == 404
