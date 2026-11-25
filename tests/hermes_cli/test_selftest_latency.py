"""Behavior contracts for the latency canary (plan §3c: advisory-only)."""

import argparse
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from hermes_cli import compression_advisor, selftest_latency as st
from hermes_cli.config import DEFAULT_CONFIG
from hermes_constants import get_hermes_home

CONFIG = {
    "model": {"provider": "OpenRouter", "default": "vendor/primary", "base_url": "https://a.test/v1/"},
    "fallback_providers": [
        {"provider": "anthropic", "model": "claude-x"},
        {"provider": "openrouter", "model": "vendor/primary", "base_url": "https://a.test/v1"},
        {"provider": "zai"},
        {"provider": "custom", "model": "local", "base_url": "http://h:1/v1", "api_key": "k"},
    ],
}


def _chunk(text=None):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])


class _Clock:
    def __init__(self, *ticks):
        self.ticks = list(ticks)

    def __call__(self):
        return self.ticks.pop(0)


def _client(create):
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def _result(label, ttft=None, error="", provider="p", model="m"):
    return st.Result(st.Target(label, provider, model), ttft_ms=ttft, total_ms=ttft, error=error)


def test_canary_is_off_by_default():
    assert st.latency_settings(DEFAULT_CONFIG)["enabled"] is False
    assert st.latency_settings({})["enabled"] is False


def test_targets_are_main_then_fallbacks_one_per_route():
    out = st.targets(CONFIG)
    assert [(t.label, t.provider) for t in out][:2] == [("main", "openrouter"),
                                                       ("fallback_providers[0]", "anthropic")]
    assert [t.provider for t in out] == ["openrouter", "anthropic", "custom"]
    assert out[0].provider == "openrouter" and out[0].base_url == "https://a.test/v1"
    assert out[-1].api_key == "k"


def test_ttft_is_first_content_chunk_not_role_preamble():
    def create(**kw):
        assert kw["stream"] is True and kw["messages"][0]["role"] == "user"
        return iter([_chunk(None), _chunk("OK"), _chunk(None)])

    clock = _Clock(10.0, 10.2, 11.5, 11.6, 11.7)
    r = st.measure(st.Target("main", "p", "m"), timeout_s=5,
                   resolve=lambda t: (_client(create), "m"), clock=clock)
    assert r.ok and r.streamed
    assert r.ttft_ms == 1500 and r.total_ms == 1700


def test_non_streaming_adapter_counts_full_reply_as_ttft():
    clock = _Clock(0.0, 2.0)
    r = st.measure(st.Target("main", "p", "m"), timeout_s=5,
                   resolve=lambda t: (_client(lambda **kw: SimpleNamespace(choices=[])), "m"),
                   clock=clock)
    assert r.ok and not r.streamed and r.ttft_ms == r.total_ms == 2000


def test_client_without_timeout_kwarg_is_retried_once_without_it():
    calls = []

    def create(**kw):
        calls.append(kw)
        if "timeout" in kw:
            raise TypeError("create() got an unexpected keyword argument 'timeout'")
        return iter([_chunk("OK")])

    r = st.measure(st.Target("main", "p", "m"), timeout_s=5,
                   resolve=lambda t: (_client(create), "m"))
    assert r.ok and len(calls) == 2


@pytest.mark.parametrize("resolve", [
    lambda t: (None, None),
    lambda t: (_client(lambda **kw: (_ for _ in ()).throw(TimeoutError("read timed out"))), "m"),
    lambda t: (_ for _ in ()).throw(RuntimeError("bad provider")),
])
def test_failures_are_results_not_exceptions(resolve):
    r = st.measure(st.Target("main", "p", "m"), timeout_s=5, resolve=resolve)
    assert not r.ok and r.error


def test_healthy_run_raises_nothing():
    assert st.evaluate([_result("main", 900), _result("fallback_providers[0]", 10_000)], 10_000) == []


def test_breaches_and_failures_become_advisories_with_stable_keys():
    results = [_result("main", 12_000), _result("fallback_providers[0]", error="401", provider="q")]
    out = st.evaluate(results, 10_000)
    assert [a.kind for a in out] == ["slow", "unreachable"]
    assert all(a.dedupe_key.startswith(f"{st.DEDUPE_PREFIX}:") for a in out)
    assert [a.dedupe_key for a in st.evaluate(results, 10_000)] == [a.dedupe_key for a in out]
    assert all("Nothing was changed" in a.body for a in out)


def test_slow_main_suggests_fastest_healthy_fallback():
    results = [
        _result("main", 30_000),
        _result("fallback_providers[0]", 4_000, provider="a", model="ma"),
        _result("fallback_providers[1]", 1_000, provider="b", model="mb"),
        _result("fallback_providers[2]", 50_000, provider="c", model="mc"),
    ]
    main_adv = st.evaluate(results, 10_000)[0]
    assert main_adv.suggested == {"model.provider": "b", "model.default": "mb"}


def _args(**kw):
    return argparse.Namespace(**{"force": False, "no_deliver": False, **kw})


def test_disabled_canary_makes_no_requests():
    with patch("hermes_cli.config.load_config", return_value=CONFIG), \
            patch.object(st, "measure") as measure:
        assert st.latency_command(_args()) == 0
    measure.assert_not_called()


def test_force_runs_every_target_and_no_deliver_raises_no_cards():
    with patch("hermes_cli.config.load_config", return_value=CONFIG), \
            patch.object(st, "measure", side_effect=lambda t, **kw: st.Result(t, error="down")) as measure, \
            patch.object(compression_advisor, "deliver") as deliver:
        assert st.latency_command(_args(force=True, no_deliver=True)) == 0
    assert measure.call_count == len(st.targets(CONFIG))
    deliver.assert_not_called()


def test_breach_is_delivered_as_needs_you_card_and_config_is_untouched():
    advisories = st.evaluate([_result("main", 20_000)], 10_000)

    async def notify(user_id, a):
        n = SimpleNamespace(id="n1", status="pending", dedupe_key=a.dedupe_key, kind="proactive_ask",
                            title=a.title, body=a.body, created_at=0, reversible=False,
                            context=None, target_user_id=user_id)
        return SimpleNamespace(notification=n, created=True, deliver_now=True)

    config_path = get_hermes_home() / "config.yaml"
    before = config_path.read_bytes() if config_path.exists() else None
    push = AsyncMock(return_value=1)
    with patch("hermes_cli.needs_you.push_new", push), \
            patch("hermes_cli.human_comms.notification_target_user", lambda n: n.target_user_id):
        assert asyncio.run(compression_advisor.deliver(advisories, "owner-1", notify)) == 1
    assert push.await_args.args[0] == "owner-1"
    after = config_path.read_bytes() if config_path.exists() else None
    assert before == after
