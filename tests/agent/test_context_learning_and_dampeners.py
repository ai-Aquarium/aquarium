"""Behavior contracts for self-calibrating context length + per-turn
compression dampeners.

Plan: plans/2026-11-25-context-length-learning-and-compression-loop.md
(§3b invariants, "Tests" and "Acceptance criteria").
"""

import logging
from unittest.mock import patch

import pytest

from agent.context_compressor import (
    ContextCompressor,
    _SUMMARY_TOKENS_CEILING,
)
from agent.model_metadata import (
    CONTEXT_PROBE_TIERS,
    MINIMUM_CONTEXT_LENGTH,
    get_cached_context_length,
    get_model_context_length,
    get_probe_tier_above,
    load_context_length_events,
    save_context_length,
)

MODEL = "vendor/model-x"
BASE_URL = "https://llm.example.test/v1"


def make_compressor(context_length=128_000, threshold=0.5, config_context_length=None, **kw):
    with patch("agent.context_compressor.get_model_context_length", return_value=context_length):
        return ContextCompressor(
            model=MODEL,
            base_url=BASE_URL,
            threshold_percent=threshold,
            protect_first_n=1,
            protect_last_n=2,
            quiet_mode=True,
            config_context_length=config_context_length,
            **kw,
        )


def conversation(turns=40, chars=8_000, head_chars=20):
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "h" * head_chars}]
    for i in range(turns):
        msgs.append({"role": "assistant", "content": f"a{i} " + "x" * chars})
        msgs.append({"role": "user", "content": f"u{i} " + "y" * chars})
    return msgs


def tool_heavy_conversation(rounds=12, tool_chars=40_000):
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "start"}]
    for i in range(rounds):
        msgs.append({
            "role": "assistant", "content": "",
            "tool_calls": [{"id": f"c{i}", "type": "function",
                            "function": {"name": "read_file", "arguments": f'{{"path": "f{i}"}}'}}],
        })
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"out{i} " + "z" * tool_chars})
        msgs.append({"role": "assistant", "content": f"done {i}"})
        msgs.append({"role": "user", "content": f"next {i}"})
    return msgs


class SummaryCounter:
    """Stands in for the aux-LLM summary call; optionally advances a fake clock."""

    def __init__(self, clock=None, seconds_per_call=0.0):
        self.calls = 0
        self.clock = clock
        self.seconds_per_call = seconds_per_call

    def __call__(self, *args, **kwargs):
        self.calls += 1
        if self.clock is not None:
            self.clock.advance(self.seconds_per_call)
        return "## Summary\nprior work summarised"


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def advance(self, seconds):
        self.now += seconds

    def monotonic(self):
        return self.now


# ---------------------------------------------------------------------------
# Probe tiers
# ---------------------------------------------------------------------------

class TestProbeTierAbove:
    @pytest.mark.parametrize("n", [1, 7_999, 8_000, 100_000, 128_000, 137_000, 255_999])
    def test_smallest_tier_strictly_above(self, n):
        above = get_probe_tier_above(n)
        assert above > n
        assert above in CONTEXT_PROBE_TIERS
        assert not [t for t in CONTEXT_PROBE_TIERS if n < t < above]

    @pytest.mark.parametrize("n", [256_000, 300_000, 1_000_001])
    def test_above_every_tier_rounds_up(self, n):
        above = get_probe_tier_above(n)
        assert above > n
        assert above - n <= 64_000


# ---------------------------------------------------------------------------
# Phase A — upward learning
# ---------------------------------------------------------------------------

class TestUpwardLearning:
    def test_accepted_prompt_above_window_learns_upward(self, caplog):
        c = make_compressor(context_length=128_000, threshold=0.5)
        with caplog.at_level(logging.INFO, logger="agent.model_metadata"):
            c.update_from_response({"prompt_tokens": 137_000, "completion_tokens": 10})
        assert c.context_length == get_probe_tier_above(137_000)
        assert c.context_length > 137_000
        assert get_cached_context_length(MODEL, BASE_URL) == c.context_length
        # Every budget is re-derived from the learned window, exactly as a
        # model switch to that window would.
        assert c.threshold_tokens == c._compute_threshold_tokens(
            c.context_length, c.threshold_percent, c.max_tokens,
        )
        assert c.tail_token_budget == int(c.threshold_tokens * c.summary_target_ratio)
        assert c.max_summary_tokens == min(int(c.context_length * 0.05), _SUMMARY_TOKENS_CEILING)
        assert sum("Learned context length upward" in r.message for r in caplog.records) == 1
        events = load_context_length_events()
        assert [(e["key"], e["direction"], e["old"], e["new"]) for e in events] == [
            (f"{MODEL}@{BASE_URL}", "up", 128_000, c.context_length)
        ]

    def test_learned_window_matches_a_switch_to_that_window(self):
        learned = make_compressor(context_length=128_000)
        learned.update_from_response({"prompt_tokens": 137_000})
        fresh = make_compressor(context_length=learned.context_length)
        for attr in ("context_length", "threshold_tokens", "tail_token_budget", "max_summary_tokens"):
            assert getattr(learned, attr) == getattr(fresh, attr)

    @pytest.mark.parametrize("prompt", [0, 50_000, 128_000])
    def test_no_change_when_prompt_fits_assumed_window(self, prompt):
        c = make_compressor(context_length=128_000)
        before = (c.context_length, c.threshold_tokens, c.tail_token_budget)
        c.update_from_response({"prompt_tokens": prompt})
        assert (c.context_length, c.threshold_tokens, c.tail_token_budget) == before
        assert get_cached_context_length(MODEL, BASE_URL) is None

    def test_explicit_config_context_length_disables_learning(self):
        c = make_compressor(context_length=128_000, config_context_length=128_000)
        before = dict(vars(c))
        c.update_from_response({"prompt_tokens": 137_000})
        assert c.context_length == 128_000
        assert c.threshold_tokens == before["threshold_tokens"]
        assert get_cached_context_length(MODEL, BASE_URL) is None
        assert load_context_length_events() == []

    def test_learned_context_flag_off_disables_learning(self):
        c = make_compressor(context_length=128_000, learned_context=False)
        c.update_from_response({"prompt_tokens": 137_000})
        assert c.context_length == 128_000
        assert get_cached_context_length(MODEL, BASE_URL) is None

    def test_learning_is_per_endpoint(self):
        c = make_compressor(context_length=128_000)
        c.update_from_response({"prompt_tokens": 137_000})
        assert get_cached_context_length(MODEL, "https://other.example.test/v1") is None

    def test_model_switch_rederives_from_new_models_own_cache_entry(self):
        other = "vendor/model-y"
        save_context_length(other, BASE_URL, 64_000)
        c = make_compressor(context_length=128_000)
        c.update_from_response({"prompt_tokens": 137_000})
        learned = c.context_length
        new_ctx = get_model_context_length(other, base_url=BASE_URL)
        c.update_model(model=other, context_length=new_ctx, base_url=BASE_URL)
        assert c.context_length == 64_000
        assert c.threshold_tokens == c._compute_threshold_tokens(64_000, c.threshold_percent, c.max_tokens)
        # Switching back reads the first model's learned entry.
        assert get_model_context_length(MODEL, base_url=BASE_URL) == learned

    def test_downward_learning_still_applies(self):
        c = make_compressor(context_length=256_000)
        c.update_model(model=MODEL, context_length=128_000, base_url=BASE_URL)
        assert c.context_length == 128_000
        assert c._context_step_down_from == 256_000


# ---------------------------------------------------------------------------
# Phase B — per-turn dampeners
# ---------------------------------------------------------------------------

class TestPerTurnLLMCap:
    def _drive_turn(self, c, tokens, max_iters=12):
        """The preflight/post-response pattern: compress while should_compress."""
        iters = 0
        while c.should_compress(tokens) and iters < max_iters:
            c.compress(conversation(), current_tokens=tokens)
            iters += 1
        return iters

    def test_at_most_cap_llm_passes_per_turn(self):
        c = make_compressor(context_length=128_000, threshold=0.5)
        c.begin_turn()
        summary = SummaryCounter()
        with patch.object(ContextCompressor, "_generate_summary", summary):
            iters = self._drive_turn(c, tokens=200_000)
        assert summary.calls == c.max_turn_llm_passes == 3
        # One deterministic pass after the cap, then the turn proceeds.
        assert c.turn_deterministic_passes == 1
        assert iters == 4
        assert not c.should_compress(200_000)

    def test_cap_is_configurable_and_zero_is_unlimited(self):
        c = make_compressor(max_turn_llm_passes=0, turn_llm_budget_ms=0)
        c.begin_turn()
        summary = SummaryCounter()
        with patch.object(ContextCompressor, "_generate_summary", summary):
            for _ in range(6):
                c.compress(conversation(), current_tokens=200_000)
        assert summary.calls == 6

    def test_new_turn_resets_the_budget(self):
        c = make_compressor(max_turn_llm_passes=1)
        c.begin_turn()
        summary = SummaryCounter()
        with patch.object(ContextCompressor, "_generate_summary", summary):
            c.compress(conversation(), current_tokens=200_000)
            c.compress(conversation(), current_tokens=200_000)
            assert summary.calls == 1
            c.begin_turn()
            assert c.should_compress(200_000)
            c.compress(conversation(), current_tokens=200_000)
        assert summary.calls == 2

    def test_manual_compress_is_never_capped(self):
        c = make_compressor(max_turn_llm_passes=1)
        c.begin_turn()
        summary = SummaryCounter()
        with patch.object(ContextCompressor, "_generate_summary", summary):
            c.compress(conversation(), current_tokens=200_000)
            c.compress(conversation(), current_tokens=200_000, force=True)
        assert summary.calls == 2

    def test_time_budget_blocks_further_llm_passes(self):
        clock = FakeClock()
        c = make_compressor(turn_llm_budget_ms=60_000)
        c.begin_turn()
        summary = SummaryCounter(clock=clock, seconds_per_call=61)
        with patch("agent.context_compressor.time.monotonic", clock.monotonic), \
                patch.object(ContextCompressor, "_generate_summary", summary):
            c.compress(conversation(), current_tokens=200_000)
            assert c.turn_compress_ms >= 60_000
            c.compress(conversation(), current_tokens=200_000)
        assert summary.calls == 1
        assert c.turn_deterministic_passes == 1

    def test_abort_on_summary_failure_leaves_messages_unchanged_past_cap(self):
        c = make_compressor(max_turn_llm_passes=1, abort_on_summary_failure=True)
        c.begin_turn()
        summary = SummaryCounter()
        with patch.object(ContextCompressor, "_generate_summary", summary):
            c.compress(conversation(), current_tokens=200_000)
            msgs = conversation()
            out = c.compress(msgs, current_tokens=200_000)
        assert summary.calls == 1
        assert len(out) == len(msgs)
        assert c._last_compress_aborted is True
        assert not c.should_compress(200_000)


class TestNonConvergence:
    def test_small_shrink_still_over_threshold_suppresses_llm_for_the_turn(self):
        c = make_compressor(context_length=128_000, threshold=0.5)
        c.begin_turn()
        # A huge protected head: summarising the middle barely moves the size.
        msgs = conversation(turns=8, chars=200, head_chars=1_200_000)
        summary = SummaryCounter()
        with patch.object(ContextCompressor, "_generate_summary", summary):
            c.compress(msgs, current_tokens=320_000)
            assert summary.calls == 1
            assert c.turn_compress_ineffective == 1
            c.compress(conversation(turns=8, chars=200, head_chars=1_200_000), current_tokens=320_000)
        assert summary.calls == 1
        assert not c.should_compress(320_000)

    def test_convergent_pass_does_not_suppress(self):
        c = make_compressor(context_length=128_000, threshold=0.5)
        c.begin_turn()
        with patch.object(ContextCompressor, "_generate_summary", SummaryCounter()):
            c.compress(conversation(), current_tokens=200_000)
        assert c.turn_compress_ineffective == 0
        assert c._turn_llm_block_reason() is None


class TestDeterministicPrune:
    def test_prune_still_runs_after_llm_cap(self):
        c = make_compressor(context_length=128_000, max_turn_llm_passes=1)
        c.begin_turn()
        summary = SummaryCounter()
        with patch.object(ContextCompressor, "_generate_summary", summary):
            c.compress(conversation(), current_tokens=200_000)
            pruned_calls = []
            real_prune = ContextCompressor._prune_old_tool_results

            def spy(self, *a, **kw):
                out = real_prune(self, *a, **kw)
                pruned_calls.append(out[1])
                return out

            with patch.object(ContextCompressor, "_prune_old_tool_results", spy):
                c.compress(tool_heavy_conversation(), current_tokens=200_000)
        assert summary.calls == 1
        assert pruned_calls and pruned_calls[0] > 0

    def test_pass_resolved_by_pruning_alone_makes_no_llm_call(self):
        c = make_compressor(context_length=128_000, threshold=0.5)
        c.begin_turn()
        msgs = tool_heavy_conversation(rounds=12, tool_chars=40_000)
        summary = SummaryCounter()
        just_over = c.threshold_tokens + 1_000
        with patch.object(ContextCompressor, "_generate_summary", summary):
            out = c.compress(msgs, current_tokens=just_over)
        assert summary.calls == 0
        assert len(out) == len(msgs)
        pruned = [m for m in out if m["role"] == "tool" and len(m["content"]) < 1_000]
        assert pruned, "old tool outputs were not pruned"
        assert c.turn_compress_passes == 1


class TestPreflightPrefersRealUsage:
    def test_real_under_threshold_defers_inflated_rough_estimate(self):
        c = make_compressor(context_length=128_000, threshold=0.5)
        c.begin_turn()
        rough = c.threshold_tokens + 20_000  # schema-heavy overestimate
        c.note_preflight_estimate(rough)
        c.update_from_response({"prompt_tokens": c.threshold_tokens - 10_000})
        # Next turn: rough estimate still above threshold, barely grown.
        c.begin_turn()
        assert c.should_defer_preflight_to_real_usage(rough + 1_000) is True

    def test_real_growth_beyond_tolerance_is_not_deferred(self):
        c = make_compressor(context_length=128_000, threshold=0.5)
        rough = c.threshold_tokens + 20_000
        c.note_preflight_estimate(rough)
        c.update_from_response({"prompt_tokens": c.threshold_tokens - 10_000})
        assert c.should_defer_preflight_to_real_usage(rough + 50_000) is False

    def test_real_over_threshold_is_not_deferred(self):
        c = make_compressor(context_length=128_000, threshold=0.5)
        rough = c.threshold_tokens + 20_000
        c.note_preflight_estimate(rough)
        c.update_from_response({"prompt_tokens": c.threshold_tokens + 5_000})
        assert c.should_defer_preflight_to_real_usage(rough) is False


# ---------------------------------------------------------------------------
# Acceptance — incident replay
# ---------------------------------------------------------------------------

class TestIncidentReplay:
    def test_wrong_128k_assumption_threshold_0_2(self, caplog):
        """~133K session, compression.threshold 0.2, window assumed 128K.

        The turn spends <= 2 min compressing and <= 3 LLM passes; the first
        accepted ~137K response learns the window upward.
        """
        clock = FakeClock()
        c = make_compressor(context_length=128_000, threshold=0.2)
        assert c.threshold_tokens == MINIMUM_CONTEXT_LENGTH  # floor dominates
        c.begin_turn()
        tokens = 133_000
        summary = SummaryCounter(clock=clock, seconds_per_call=40)
        with patch("agent.context_compressor.time.monotonic", clock.monotonic), \
                patch.object(ContextCompressor, "_generate_summary", summary):
            passes = 0
            # The rough estimate never drops below the floor: the pre-fix
            # loop ran ~13 passes over ~9 minutes here.
            while c.should_compress(tokens) and passes < 20:
                c.compress(conversation(), current_tokens=tokens)
                passes += 1
        assert summary.calls <= 3
        assert c.turn_compress_ms <= 120_000
        stats = c.turn_compression_stats()
        assert stats["compress_llm_passes"] == summary.calls
        assert stats["compress_ms"] == c.turn_compress_ms

        with caplog.at_level(logging.INFO, logger="agent.model_metadata"):
            c.update_from_response({"prompt_tokens": 137_000})
        assert c.context_length > 137_000
        assert get_cached_context_length(MODEL, BASE_URL) == c.context_length
        assert any("Learned context length upward" in r.message for r in caplog.records)

    def test_explicit_context_length_behaves_as_before(self):
        explicit = make_compressor(context_length=128_000, threshold=0.2, config_context_length=128_000)
        explicit.update_from_response({"prompt_tokens": 137_000})
        assert explicit.context_length == 128_000
        assert get_cached_context_length(MODEL, BASE_URL) is None
