"""FG-03 P5: the triage scripts honour ``triage.agent.<channel>``.

The real email/WhatsApp scripts run with the router, the per-profile agent
triage and the handlers stubbed at their interfaces; the real-path version is
``test_fg03_profile_triage_e2e``.
"""

import json
import types
from pathlib import Path

import pytest

from hermes_cli import triage_agent
from hermes_cli.triage_agent import ProfileTriage
from tests.custom.test_fg03_batch_routing import (  # noqa: F401 — pytest fixtures
    Pipeline,
    _decision,
    credit,
    email_triage,
    pipeline,
    router,
    wa_triage,
)

AGENT_RESULT = {"classification": "action_required", "escalate": True, "tasks": [], "notes": []}


@pytest.fixture
def agents(monkeypatch, router):  # noqa: F811
    """Stub the P5 agent layer and the handlers; record what they were asked."""
    state = types.SimpleNamespace(mode="agent", failing=set(), runs=[], acted=[],
                                  compared=[], legacy_acted=[])

    def triage_selected(kind, batch, profiles, *, owner_user_id, config=None, runner=None):
        state.runs.append(list(profiles))
        assert not any(k.startswith("_profiles") or k.startswith("_agent") for k in batch)
        return [ProfileTriage(profile=p, owner_user_id=owner_user_id, home=Path(f"/homes/{p}"),
                              **({"error": "turn failed"} if p in state.failing
                                 else {"result": dict(AGENT_RESULT)}))
                for p in profiles]

    def record_comparisons_sync(**kwargs):
        state.compared.append(kwargs)
        return True

    def process_result(result, batch, db, *, profile_home=None, owner_user_id=None,
                       box_writes=True):
        state.acted.append((str(profile_home) if profile_home else None, owner_user_id,
                            box_writes, batch["_channel"]))

    monkeypatch.setattr(triage_agent, "agent_mode", lambda channel, config=None: state.mode)
    monkeypatch.setattr(triage_agent, "triage_selected", triage_selected)
    monkeypatch.setattr(triage_agent, "record_comparisons_sync", record_comparisons_sync)
    monkeypatch.setattr("shared.triage_handlers.process_result", process_result)
    return state


def _batch(pipeline, path):  # noqa: F811
    for p in (path, Path(pipeline.processed, path.name)):
        if p.exists():
            return json.loads(p.read_text())
    raise AssertionError(path)


def test_legacy_mode_is_todays_triage(pipeline, router, agents):  # noqa: F811
    agents.mode, router.decision = "legacy", _decision("cfo", "cmo")
    path = pipeline.write("b1")
    pipeline.run(path)
    assert len(router.calls) == 1
    assert pipeline.triaged == ["b1"] and pipeline.stored == ["b1"] and pipeline.done(path)
    assert agents.runs == [] and agents.acted == [] and agents.compared == []


def test_shadow_acts_on_legacy_and_only_stores_the_agents(pipeline, router, agents):  # noqa: F811
    agents.mode, router.decision = "shadow", _decision("cfo", "cmo")
    agents.failing = {"cmo"}
    path = pipeline.write("b2")
    pipeline.run(path)
    assert len(router.calls) == 1
    assert pipeline.triaged == ["b2"] and pipeline.stored == ["b2"] and pipeline.done(path)
    assert agents.runs == [["cfo", "cmo"]] and agents.acted == []
    [compared] = agents.compared
    assert (compared["batch_id"], compared["channel"], compared["owner_user_id"]) == (
        "b2", pipeline.kind, "u-john")
    assert compared["legacy_result"]["classification"] == "informational"
    assert [(a.profile, a.ok) for a in compared["agents"]] == [("cfo", True), ("cmo", False)]


def test_shadow_failures_never_touch_legacy(pipeline, router, agents, monkeypatch):  # noqa: F811
    agents.mode, router.decision = "shadow", _decision("cfo")
    monkeypatch.setattr(triage_agent, "triage_selected",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    path = pipeline.write("b3")
    pipeline.run(path)
    assert pipeline.stored == ["b3"] and pipeline.done(path) and agents.compared == []


def test_shadow_with_no_pick_runs_no_agent(pipeline, router, agents):  # noqa: F811
    agents.mode, router.decision = "shadow", _decision()
    pipeline.run(pipeline.write("b4"))
    assert pipeline.stored == ["b4"] and agents.runs == []


def test_agent_mode_acts_in_each_picked_profile_once_box_wide(pipeline, router, agents):  # noqa: F811
    router.decision = _decision("cfo", "cmo")
    path = pipeline.write("b5")
    pipeline.run(path)
    assert len(router.calls) == 1
    assert pipeline.triaged == [] and pipeline.stored == []
    assert agents.acted == [("/homes/cfo", "u-john", True, pipeline.kind),
                            ("/homes/cmo", "u-john", False, pipeline.kind)]
    assert pipeline.done(path)
    assert _batch(pipeline, path)["_profiles_done"] == ["cfo", "cmo"]


def test_agent_mode_with_no_pick_stores_only(pipeline, router, agents):  # noqa: F811
    router.decision = _decision()
    path = pipeline.write("b6")
    pipeline.run(path)
    assert pipeline.triaged == [] and agents.runs == [] and pipeline.done(path)


@pytest.mark.parametrize("router_mode,decision", [("shadow", None), ("off", _decision("cfo"))])
def test_agent_mode_without_a_decision_is_legacy(pipeline, router, agents, router_mode, decision):  # noqa: F811
    router.mode, router.decision = router_mode, decision
    path = pipeline.write("b7")
    pipeline.run(path)
    assert pipeline.triaged == ["b7"] and pipeline.stored == ["b7"] and pipeline.done(path)
    assert agents.runs == []


def test_agent_mode_unsourced_batch_is_legacy(pipeline, router, agents):  # noqa: F811
    router.decision = _decision("cfo")
    pipeline.run(pipeline.write("b8", source_id=None))
    assert router.calls == [] and pipeline.triaged == ["b8"] and agents.runs == []


def test_failed_profiles_retry_alone_then_fall_back_to_legacy(pipeline, router, agents):  # noqa: F811
    router.decision = _decision("cfo", "cmo")
    agents.failing = {"cmo"}
    path = pipeline.write("b9")
    for attempt in (1, 2):
        pipeline.run(path)
        assert path.exists()
        batch = _batch(pipeline, path)
        assert batch["_profiles_done"] == ["cfo"] and batch["_agent_attempts"] == attempt
    pipeline.run(path)
    assert agents.runs == [["cfo", "cmo"], ["cmo"], ["cmo"]]
    assert len(router.calls) == 3  # one per attempt; a stored decision makes no model call
    # cfo wrote the box-wide rows once; the legacy fallback must not repeat them.
    assert agents.acted == [("/homes/cfo", "u-john", True, pipeline.kind),
                            (None, None, False, pipeline.kind)]
    assert pipeline.triaged == ["b9"] and pipeline.stored == [] and pipeline.done(path)


def test_all_profiles_failing_falls_back_to_full_legacy(pipeline, router, agents):  # noqa: F811
    router.decision = _decision("cfo")
    agents.failing = {"cfo"}
    path = pipeline.write("b10")
    for _ in range(3):
        pipeline.run(path)
    assert agents.runs == [["cfo"]] * 3 and agents.acted == []
    assert pipeline.triaged == ["b10"] and pipeline.stored == ["b10"] and pipeline.done(path)


def test_legacy_fallback_that_fails_retries_legacy_only(pipeline, router, agents, monkeypatch):  # noqa: F811
    router.decision = _decision("cfo")
    agents.failing = {"cfo"}
    path = pipeline.write("b11")
    name = "triage_email_batch" if pipeline.kind == "email" else "triage_batch"
    monkeypatch.setattr(pipeline.module, name, lambda b: None)
    for _ in range(4):
        pipeline.run(path)
    assert agents.runs == [["cfo"]] * 3 and path.exists()
    assert _batch(pipeline, path)["_agent_attempts"] == 3
