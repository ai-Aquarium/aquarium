"""FG-03 P5 — full triage in a chosen user-profile's agent (unit level).

Real triage skill layers over tmp profile homes; the owner check and the model
turn are stand-ins here (the real ones run in ``test_triage_agent_e2e``).
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import triage_agent as ta
from hermes_cli import triage_skills as tsk

REPO = Path(__file__).resolve().parents[2]
LEGACY = {
    "email": REPO / "custom/email/email_triage_agent.py",
    "whatsapp": REPO / "custom/whatsapp/triage_agent.py",
    "calendar": REPO / "custom/calendar/calendar_triage_agent.py",
}
EMAIL = {
    "batch_id": "b-1", "sender": "ann@example.com", "sender_name": "Ann",
    "account_id": "john@example.com", "email_count": 1,
    "emails": [{"subject": "Invoice INV-9", "body_text": "Please pay", "has_attachments": True}],
}
WHATSAPP = {
    "batch_id": "w-1", "sender_phone": "111", "source_phone": "222", "message_count": 1,
    "is_family": True, "family_contact": {"name": "Mum", "relation": "mother"},
    "messages": [{"timestamp": "10:00", "text": "call me", "sender_name": "Mum"}],
}
CALENDAR = {
    "event": {"id": "ev-1", "summary": "Board", "start_time": "09:00", "end_time": "10:00",
              "organizer_name": "Leo", "organizer_email": "leo@example.com"},
    "attendees": [{"display_name": "John", "email": "john@example.com",
                   "response_status": "accepted", "self": True}],
}
REPLY = {"classification": "invoice", "summary": "s", "escalate": False, "tasks": []}


@pytest.fixture
def homes(tmp_path):
    cfo, cmo = tmp_path / "cfo", tmp_path / "cmo"
    for home in (cfo, cmo):
        home.mkdir()
    tsk.write_care("email", "John@CFO: invoices", layer="user", home=cfo, user_id="john", author="john")
    tsk.write_care("email", "Mary@CFO: board papers", layer="user", home=cfo, user_id="mary", author="mary")
    tsk.write_care("email", "CMO template: launches", layer="template", home=cmo, author="o")
    return {"cfo": cfo, "cmo": cmo}


@pytest.fixture
def profiles(monkeypatch, homes):
    """``hermes_cli.profiles`` sees ``homes``; ``active`` lists who is in each."""
    import hermes_cli.profiles as hp

    active = {"cfo": {"john", "mary"}, "cmo": {"john"}}
    monkeypatch.setattr(hp, "profile_exists", lambda name: name in homes)
    monkeypatch.setattr(hp, "get_profile_dir", lambda name: homes[name])

    def resolve(home, owner):
        profile = next(p for p, h in homes.items() if h == home)
        return None if owner in active[profile] else f"the job's owner {owner} is not an active person here"

    monkeypatch.setattr(ta, "_resolve_owner", resolve)
    return active


class Runner:
    def __init__(self, reply=json.dumps(REPLY)):
        self.reply = reply
        self.calls: list[dict] = []

    def __call__(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


# -- mode -----------------------------------------------------------------------


def test_agent_mode_defaults_to_legacy_and_reads_each_channel():
    from hermes_cli.config import DEFAULT_CONFIG

    assert {c: ta.agent_mode(c, DEFAULT_CONFIG) for c in ta.CHANNELS} == dict.fromkeys(ta.CHANNELS, "legacy")
    config = {"triage": {"agent": {"email": "Shadow", "whatsapp": "agent", "calendar": "bogus"}}}
    assert [ta.agent_mode(c, config) for c in ta.CHANNELS] == ["shadow", "agent", "legacy"]
    assert ta.agent_mode("email", {}) == "legacy"
    assert ta.agent_mode("email", {"triage": None}) == "legacy"
    assert ta.agent_mode("telegram", config) == "legacy"


# -- prompt ---------------------------------------------------------------------


@pytest.mark.parametrize("kind", ta.CHANNELS)
def test_instructions_are_todays_legacy_wording(kind):
    source = LEGACY[kind].read_text()
    assert ta._LEGACY_INTRO[kind] in source
    assert ta._LEGACY_CLOSING[kind] in source


def test_prompt_prefix_is_byte_stable_and_the_batch_is_last(homes):
    one = ta.build_triage_prompt("email", EMAIL, home=homes["cfo"], owner_user_id="john")
    other = ta.build_triage_prompt("email", {**EMAIL, "emails": [{"subject": "Lunch?"}]},
                                   home=homes["cfo"], owner_user_id="john")
    prefix = ta._prompt_prefix("email", homes["cfo"], "john")
    assert one.startswith(prefix) and other.startswith(prefix)
    assert one[len(prefix):].startswith("Triage this email batch:")
    assert "INV-9" in one[len(prefix):] and "INV-9" not in prefix
    assert one.index(ta._LEGACY_INTRO["email"]) < one.index("John@CFO") < one.index(ta._AGENT_RULES)
    # The skills' response schema is the contract.
    for field in ('"classification"', '"todos"', '"work_request"', '"memory_facts"',
                  '"escalation_priority"'):
        assert field in prefix


def test_prompt_carries_only_the_owners_layer(homes):
    john = ta.build_triage_prompt("email", EMAIL, home=homes["cfo"], owner_user_id="john")
    mary = ta.build_triage_prompt("email", EMAIL, home=homes["cfo"], owner_user_id="mary")
    assert "John@CFO" in john and "Mary@CFO" not in john and "CMO template" not in john
    assert "Mary@CFO" in mary and "John@CFO" not in mary


def test_batch_rendering_matches_the_legacy_shape(homes):
    email = ta._render_email({**EMAIL, "is_vip": True, "contact_name": "Ann Lee"})
    assert "Sender: ann@example.com (Name: Ann)\nAccount: john@example.com\nEmail Count: 1\n" in email
    assert "- Subject: Invoice INV-9 [HAS ATTACHMENTS]\n  Body: Please pay\n" in email
    assert "Sender is a VIP CONTACT: Ann Lee. Escalate important emails." in email
    wa = ta._render_whatsapp(WHATSAPP)
    assert "Sender is a FAMILY MEMBER: Mum (mother). ALL messages from family must be escalated." in wa
    assert "- [10:00] call me\n" in wa and "Source Phone: 222" in wa
    cal = ta.build_triage_prompt("calendar", CALENDAR, home=homes["cfo"], owner_user_id="john")
    assert cal.rstrip().endswith("- John <john@example.com> [accepted] (you)")
    with pytest.raises(ValueError):
        ta.build_triage_prompt("telegram", {}, home=homes["cfo"], owner_user_id="john")


# -- reply ----------------------------------------------------------------------


@pytest.mark.parametrize("raw", [
    json.dumps(REPLY),
    f"```json\n{json.dumps(REPLY)}\n```",
    f"```\n{json.dumps(REPLY, indent=2)}\n```\n",
    f"Here you go:\n{json.dumps(REPLY)}",
])
def test_parse_reply_takes_the_json_object(raw):
    assert ta.parse_triage_reply(raw) == REPLY


@pytest.mark.parametrize("raw", [None, "", "no json", "[1, 2]", "```json\n[]\n```", "{broken", 42])
def test_parse_reply_is_none_for_anything_else(raw):
    assert ta.parse_triage_reply(raw) is None


# -- running --------------------------------------------------------------------


def test_run_profile_triage_runs_one_turn_as_the_owner(profiles, homes):
    runner = Runner(f"```json\n{json.dumps(REPLY)}\n```")
    config = {"triage": {"agent": {"model": "m"}}}
    out = ta.run_profile_triage("email", EMAIL, profile="cfo", owner_user_id="john",
                                config=config, runner=runner)
    assert out.ok and out.result == REPLY and out.error is None
    assert out.session_id == "triage_email_b-1_cfo" and out.skills_layer == "user"
    [call] = runner.calls
    assert call["profile_home"] == homes["cfo"] and call["owner_user_id"] == "john"
    assert call["session_id"] == "triage_email_b-1_cfo" and call["config"] is config
    assert call["prompt"] == ta.build_triage_prompt("email", EMAIL, home=homes["cfo"], owner_user_id="john")
    assert out.as_dict() == {
        "profile": "cfo", "owner_user_id": "john", "home": str(homes["cfo"]), "result": REPLY,
        "error": None, "session_id": "triage_email_b-1_cfo", "skills_layer": "user", "ok": True,
    }


@pytest.mark.parametrize("profile,owner,reason", [
    ("hr", "john", "no profile 'hr'"),
    ("cmo", "mary", "mary is not an active person"),
    ("cfo", "", "no owner"),
])
def test_refusals_never_run_a_turn(profiles, profile, owner, reason):
    runner = Runner()
    out = ta.run_profile_triage("email", EMAIL, profile=profile, owner_user_id=owner, runner=runner)
    assert not out.ok and out.error.startswith("refused") and reason in out.error
    assert runner.calls == []


def test_failures_are_reported_not_raised(profiles):
    bad = ta.run_profile_triage("email", EMAIL, profile="cfo", owner_user_id="john",
                                runner=Runner("I think it's an invoice."))
    assert bad.error.startswith("unparseable reply") and bad.session_id == "triage_email_b-1_cfo"
    boom = ta.run_profile_triage("email", EMAIL, profile="cfo", owner_user_id="john",
                                 runner=Runner(ConnectionError("provider 503")))
    assert boom.error == "ConnectionError: provider 503" and boom.result is None
    kind = ta.run_profile_triage("telegram", EMAIL, profile="cfo", owner_user_id="john", runner=Runner())
    assert kind.error.startswith("ValueError")


def test_triage_selected_keeps_the_routers_order(profiles):
    runner = Runner()
    out = ta.triage_selected("email", EMAIL, ["cmo", "hr", "cfo"], owner_user_id="john",
                             config={}, runner=runner)
    assert [(o.profile, o.ok) for o in out] == [("cmo", True), ("hr", False), ("cfo", True)]
    assert [c["session_id"] for c in runner.calls] == ["triage_email_b-1_cmo", "triage_email_b-1_cfo"]


def test_default_runner_is_looked_up_at_call_time(profiles, monkeypatch):
    runner = Runner()
    monkeypatch.setattr(ta, "_default_runner", runner)
    assert ta.run_profile_triage("calendar", CALENDAR, profile="cfo", owner_user_id="john").ok
    assert runner.calls[0]["session_id"] == "triage_calendar_ev-1_cfo"


def test_default_runner_is_one_toolless_turn_that_never_writes_memory(monkeypatch, tmp_path):
    import agent.seeded_session as ss

    seen = {}

    def spawn(prompt, **kwargs):
        seen.update(kwargs, prompt=prompt)
        return SimpleNamespace(error=None, timed_out=False, result={"final_response": "{}"})

    monkeypatch.setattr(ss, "spawn_seeded_session", spawn)
    config = {"triage": {"agent": {"model": "cheap-1", "max_iterations": 3}}}
    assert ta._default_runner("p", profile_home=tmp_path, owner_user_id="john",
                              session_id="triage_email_b_cfo", config=config) == "{}"
    assert seen == {
        "prompt": "p", "origin": "triage", "session_id": "triage_email_b_cfo",
        "profile_home": tmp_path, "model": "cheap-1", "enabled_toolsets": [],
        "max_iterations": 3, "skip_memory": True, "internal_user_id": "john",
    }
    ta._default_runner("p", profile_home=tmp_path, owner_user_id="john", session_id="s", config={})
    assert seen["model"] is None and seen["max_iterations"] == ta.DEFAULT_MAX_ITERATIONS

    monkeypatch.setattr(ss, "spawn_seeded_session",
                        lambda prompt, **kw: SimpleNamespace(error="boom", timed_out=False, result=None))
    with pytest.raises(RuntimeError, match="boom"):
        ta._default_runner("p", profile_home=tmp_path, owner_user_id="john", session_id="s")


def test_seeded_session_keeps_an_empty_toolset_list_toolless(monkeypatch, tmp_path):
    """``enabled_toolsets=[]`` means no tools, not every tool."""
    import run_agent
    from agent import seeded_session as ss

    built = {}

    class FakeAgent:
        def __init__(self, **kwargs):
            built.update(kwargs)
            raise RuntimeError("stop after construction")

    monkeypatch.setattr(run_agent, "AIAgent", FakeAgent)
    runtime = {"provider": "openrouter", "api_key": "k", "base_url": "http://127.0.0.1:1/v1"}
    out = ss.spawn_seeded_session("hi", origin="triage", session_id="s1", profile_home=tmp_path,
                                  runtime=runtime, model="m", enabled_toolsets=[], skip_memory=True)
    assert out.error and built["enabled_toolsets"] == []


def test_session_ids_are_safe_and_deterministic():
    assert ta.session_id_for("email", "b 1/2", "cfo") == "triage_email_b-1-2_cfo"
    assert ta.session_id_for("email", "b-1", "cfo") == ta.session_id_for("email", "b-1", "cfo")
