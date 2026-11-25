"""Behavior contracts for compression advisories (plan §4: advisory-only)."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from hermes_cli import compression_advisor as adv
from hermes_constants import get_hermes_home

FLOOR = 64_000
KEY = "vendor/model-x@https://llm.example.test/v1"


def _turn(**kw):
    base = {"session": "s1", "compress_passes": 1, "compress_ms": 1_000,
            "compress_ineffective": 0, "ctx": 256_000, "trigger": FLOOR}
    return {**base, **kw}


def test_healthy_turns_raise_nothing():
    assert adv.scan([_turn(), _turn(compress_passes=3, compress_ms=60_000)], [],
                    threshold_percent=0.2, floor=FLOOR) == []


def test_pathological_turn_suggests_threshold_that_escapes_the_floor():
    out = adv.scan([_turn(compress_ms=540_000, compress_passes=13)], [],
                   threshold_percent=0.2, floor=FLOOR)
    assert [a.kind for a in out] == ["pathological"]
    pct = out[0].suggested["compression.threshold"]
    assert 256_000 * pct > FLOOR
    assert f"{pct:g}" in out[0].body


def test_too_many_passes_alone_is_pathological():
    out = adv.scan([_turn(compress_passes=4)], [], threshold_percent=0.5, floor=FLOOR)
    assert [a.kind for a in out] == ["pathological"]


def test_floor_dominating_after_upward_learning_is_flagged():
    events = [{"ts": 1, "key": KEY, "direction": "up", "old": 128_000, "new": 256_000}]
    out = adv.scan([], events, threshold_percent=0.2, floor=FLOOR)
    assert [a.kind for a in out] == ["floor_dominates"]
    assert 256_000 * out[0].suggested["compression.threshold"] > FLOOR
    # A percentage that already expresses intent is left alone.
    assert adv.scan([], events, threshold_percent=0.5, floor=FLOOR) == []


def test_up_then_down_learning_recommends_pinning_context_length():
    events = [
        {"ts": 1, "key": KEY, "direction": "up", "old": 128_000, "new": 256_000},
        {"ts": 2, "key": KEY, "direction": "down", "old": 256_000, "new": 128_000},
    ]
    out = adv.scan([], events, threshold_percent=0.5, floor=FLOOR)
    assert [a.kind for a in out] == ["flapping"]
    assert out[0].suggested == {"model.context_length": 128_000}


def test_down_then_up_is_not_flapping():
    events = [
        {"ts": 1, "key": KEY, "direction": "down", "old": 256_000, "new": 128_000},
        {"ts": 2, "key": KEY, "direction": "up", "old": 128_000, "new": 256_000},
    ]
    assert adv.scan([], events, threshold_percent=0.5, floor=FLOOR) == []


def test_dedupe_key_is_stable_per_kind_and_subject():
    a = adv.scan([], [{"ts": 1, "key": KEY, "direction": "up", "new": 256_000}],
                 threshold_percent=0.2, floor=FLOOR)[0]
    b = adv.scan([], [{"ts": 9, "key": KEY, "direction": "up", "new": 256_000}],
                 threshold_percent=0.2, floor=FLOOR)[0]
    assert a.dedupe_key == b.dedupe_key


def test_deliver_raises_cards_and_pushes_only_new_ones_never_touching_config():
    advisories = adv.scan([_turn(compress_ms=540_000)], [], threshold_percent=0.2, floor=FLOOR)
    seen = []

    async def notify(user_id, a):
        seen.append((user_id, a.dedupe_key))
        n = SimpleNamespace(id="n1", status="pending", dedupe_key=a.dedupe_key, kind="proactive_ask",
                            title=a.title, body=a.body, created_at=0, reversible=False,
                            context=None, target_user_id=user_id)
        return SimpleNamespace(notification=n, created=True, deliver_now=True)

    config_path = get_hermes_home() / "config.yaml"
    before = config_path.read_bytes() if config_path.exists() else None
    push = AsyncMock(return_value=1)
    with patch("hermes_cli.needs_you.push_new", push), \
            patch("hermes_cli.human_comms.notification_target_user", lambda n: n.target_user_id):
        sent = asyncio.run(adv.deliver(advisories, "owner-1", notify))
    assert sent == 1
    assert seen == [("owner-1", advisories[0].dedupe_key)]
    pushed_user, pushed_items = push.await_args.args
    assert pushed_user == "owner-1" and len(pushed_items) == 1
    after = config_path.read_bytes() if config_path.exists() else None
    assert before == after


def test_deliver_skips_push_for_deduped_cards():
    advisories = adv.scan([_turn(compress_ms=540_000)], [], threshold_percent=0.2, floor=FLOOR)

    async def notify(user_id, a):
        return SimpleNamespace(notification=None, created=False, deliver_now=True)

    push = AsyncMock(return_value=0)
    with patch("hermes_cli.needs_you.push_new", push):
        assert asyncio.run(adv.deliver(advisories, "owner-1", notify)) == 0
    push.assert_not_awaited()


def test_ledger_keeps_only_turns_that_compressed():
    adv.record_turn("s1", {"compress_passes": 0, "compress_ms": 0, "compress_ineffective": 0})
    adv.record_turn("s2", {"compress_passes": 2, "compress_ms": 5_000, "compress_ineffective": 1})
    rows = adv.load_turns()
    assert [r["session"] for r in rows] == ["s2"]
    assert rows[0]["compress_ms"] == 5_000


def test_turn_timing_stats_default_to_zero_for_engines_without_a_ledger():
    from gateway.session_chat import compression_turn_stats

    zeros = {"compress_passes": 0, "compress_ms": 0, "compress_ineffective": 0}
    assert compression_turn_stats(None) == zeros
    assert compression_turn_stats(SimpleNamespace(context_compressor=object())) == zeros
