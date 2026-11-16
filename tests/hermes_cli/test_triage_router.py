"""FG-03 P4 — the triage router's prompt, reply parsing and retry/fallback.

No database and no model: the LLM and ``sleep`` are injected and the registry
reads are stubbed. The real-Postgres path is ``test_triage_router_e2e``.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from hermes_cli import source_registry as registry
from hermes_cli import triage_router as tr
from hermes_cli import triage_skills as tsk

SOURCE_ID = "11111111-1111-1111-1111-111111111111"
CFO = {"profile": "cfo", "user_id": "john", "home": "/h/cfo", "care": "Invoices.", "layer": "user"}
CMO = {"profile": "cmo", "user_id": "john", "home": "/h/cmo", "care": "Campaigns.", "layer": "template"}


def _reply(**selected):
    return json.dumps({"routes": [
        {"profile": p, "selected": s, "reason": f"{p} reason"} for p, s in selected.items()
    ]})


# -- prompt ------------------------------------------------------------------------


def test_system_prompt_is_byte_stable_and_free_of_the_batch():
    a_sys, a_user = tr.build_prompts("email", [CFO, CMO], "Invoice #1 overdue")
    b_sys, b_user = tr.build_prompts("email", [CMO, CFO], "Launch party on Friday")
    assert a_sys == b_sys
    assert a_sys == tr.build_prompts("email", [CFO, CMO], "anything")[0]
    assert "Invoice #1" not in a_sys and "Invoice #1" in a_user
    assert a_user != b_user
    assert a_sys.index("Invoices.") < a_sys.index("Campaigns.")


def test_system_prompt_changes_with_routes_or_care_text():
    base = tr.build_prompts("email", [CFO, CMO], "x")[0]
    assert tr.build_prompts("email", [CFO], "x")[0] != base
    assert tr.build_prompts("email", [CFO, {**CMO, "care": "Press."}], "x")[0] != base
    assert tr.build_prompts("whatsapp", [CFO, CMO], "x")[0] != base


def test_a_huge_batch_is_clipped():
    _, user = tr.build_prompts("email", [CFO], "x" * (tr.MAX_BATCH_CHARS * 2))
    assert len(user) < tr.MAX_BATCH_CHARS + 200


# -- reply -------------------------------------------------------------------------


def test_parse_reply_keeps_profile_order_drops_unknown_and_fills_missing():
    raw = json.dumps({"routes": [
        {"profile": "hr", "selected": True, "reason": "not routed"},
        {"profile": "cmo", "selected": True, "reason": "A launch\n  plan"},
    ]})
    assert tr.parse_reply(raw, ["cfo", "cmo"]) == (
        tr.RouteChoice("cfo", False, ""),
        tr.RouteChoice("cmo", True, "A launch plan"),
    )


def test_parse_reply_accepts_a_code_fence_and_clips_reasons():
    raw = "```json\n" + json.dumps({"routes": [
        {"profile": "cfo", "selected": False, "reason": "r" * 999}]}) + "\n```"
    [choice] = tr.parse_reply(raw, ["cfo"])
    assert not choice.selected and len(choice.reason) == tr.MAX_REASON_CHARS


@pytest.mark.parametrize("raw", [
    "",
    "Sure! CFO should get it.",
    "[]",
    '{"routes": {}}',
    '{"routes": ["cfo"]}',
    '{"routes": [{"selected": true}]}',
    '{"routes": [{"profile": "cfo", "selected": "yes", "reason": ""}]}',
    '{"routes": [{"profile": "cfo", "selected": true, "reason": 3}]}',
])
def test_parse_reply_refuses_anything_but_the_schema(raw):
    with pytest.raises(ValueError):
        tr.parse_reply(raw, ["cfo"])


# -- settings ----------------------------------------------------------------------


def test_router_settings_defaults_and_bad_values():
    assert tr.router_settings({}) == {"mode": "shadow", "retries": 3, "retry_delay_seconds": 5.0}
    got = tr.router_settings({"triage": {"router": {
        "mode": "ENFORCE", "retries": "1", "retry_delay_seconds": 0}}})
    assert got == {"mode": "enforce", "retries": 1, "retry_delay_seconds": 0.0}
    got = tr.router_settings({"triage": {"router": {
        "mode": "loud", "retries": -2, "retry_delay_seconds": "soon"}}})
    assert got == {"mode": "shadow", "retries": 0, "retry_delay_seconds": 5.0}


def test_config_defaults_carry_the_router_and_its_aux_slot():
    from hermes_cli.config import DEFAULT_CONFIG

    assert tr.router_settings(DEFAULT_CONFIG) == tr.router_settings({})
    assert DEFAULT_CONFIG["auxiliary"][tr.AUX_TASK]["provider"] == "auto"


# -- route_batch (stubbed registry) ------------------------------------------------


@pytest.fixture
def stubbed(monkeypatch):
    stored = []
    source = SimpleNamespace(source_id=SOURCE_ID, channel="email", owner_user_id="john")
    sections = [CFO, CMO]

    async def get_decision(connection, source_id, batch_id):
        return next((d for d in stored if d.batch_id == batch_id), None)

    async def store(connection, decision):
        stored.append(decision)
        return decision

    async def get_source(connection, source_id):
        return source

    async def care(connection, source_id, kind=None):
        return list(sections)

    monkeypatch.setattr(tr, "get_decision", get_decision)
    monkeypatch.setattr(tr, "_store", store)
    monkeypatch.setattr(registry, "get_source", get_source)
    monkeypatch.setattr(tsk, "care_sections_for_source", care)
    return SimpleNamespace(stored=stored, sections=sections)


class FakeLLM:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    async def __call__(self, system, user):
        self.calls.append((system, user))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class Sleeps(list):
    async def __call__(self, seconds):
        self.append(seconds)


def _route(llm, sleep=None, config=None, batch_id="b1", text="hello"):
    return asyncio.run(tr.route_batch(
        None, source_id=SOURCE_ID, batch_id=batch_id, batch_text=text,
        config=config or {}, llm=llm, sleep=Sleeps() if sleep is None else sleep,
    ))


def test_one_call_picks_profiles_with_reasons(stubbed):
    llm = FakeLLM(_reply(cfo=True, cmo=False))
    d = _route(llm)
    assert len(llm.calls) == 1
    assert d.selected == ["cfo"] and d.attempts == 1 and not d.fallback and d.error is None
    assert [c.reason for c in d.choices] == ["cfo reason", "cmo reason"]
    assert d.owner_user_id == "john" and d.channel == "email"


def test_no_routes_means_no_call_and_nothing_picked(stubbed):
    stubbed.sections.clear()
    llm = FakeLLM()
    d = _route(llm)
    assert llm.calls == [] and d.selected == [] and d.attempts == 0 and not d.fallback


def test_a_stored_decision_is_returned_without_a_call(stubbed):
    first = _route(FakeLLM(_reply(cfo=True, cmo=True)))
    llm = FakeLLM()
    assert _route(llm) is first and llm.calls == []


def test_a_bad_reply_is_retried_then_succeeds(stubbed):
    sleeps = Sleeps()
    llm = FakeLLM(RuntimeError("503"), "not json", _reply(cfo=False, cmo=True))
    d = _route(llm, sleeps, {"triage": {"router": {"retry_delay_seconds": 2}}})
    assert d.selected == ["cmo"] and d.attempts == 3 and not d.fallback
    assert sleeps == [2.0, 4.0]
    assert len({c for c in llm.calls}) == 1  # the same prompt every attempt


def test_after_the_last_failure_every_profile_gets_it(stubbed):
    sleeps = Sleeps()
    llm = FakeLLM(*[TimeoutError("slow")] * 3, "nope")
    d = _route(llm, sleeps)
    assert len(llm.calls) == 4 and sleeps == [5.0, 10.0, 15.0]
    assert d.fallback and d.attempts == 4 and d.selected == ["cfo", "cmo"]
    assert "ValueError" in d.error
    assert {c.reason for c in d.choices} == {tr.FALLBACK_REASON}


def test_retries_zero_means_one_attempt(stubbed):
    sleeps = Sleeps()
    d = _route(FakeLLM(RuntimeError("x")), sleeps, {"triage": {"router": {"retries": 0}}})
    assert d.fallback and d.attempts == 1 and sleeps == []


def test_route_batch_sync_never_raises(monkeypatch):
    async def unreachable(**kwargs):
        raise OSError("connection refused")

    monkeypatch.setattr(registry, "connect_box", unreachable)
    assert tr.route_batch_sync(source_id=SOURCE_ID, batch_id="b", batch_text="x", config={}) is None
    assert tr.route_batch_sync(source_id=SOURCE_ID, batch_id="b", batch_text="x",
                               config={"triage": {"router": {"mode": "off"}}}) is None
    assert tr.route_batch_sync(bogus=1, config={}) is None
