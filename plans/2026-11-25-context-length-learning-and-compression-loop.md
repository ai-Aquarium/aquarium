---
title: "Self-calibrating context length + compression loop dampeners"
status: proposed
date: 2026-11-25
type: design
target_repo: aquarium
---

# Self-calibrating context length + compression loop dampeners

## Ask

A single agent-home chat turn took **9m20s** because the agent ran ~14
LLM-summary compression passes before almost every API call. Two compounding
defects:

1. The assumed context window was **provably wrong** (128K assumed; the
   endpoint demonstrably accepted ~133–137K prompts), and nothing in the
   success path corrects a wrong assumption upward.
2. Nothing bounds **per-turn** compression effort: the existing caps are
   per-error-streak and reset on every successful API call, and the
   anti-thrash counter is measured against an inflated rough estimate, so
   it can reset instead of tripping.

This proposal: make context length **observed-truth driven, per
`(model, base_url)`**, and bound compression work per turn.

## Incident evidence (prod, 2026-11-25)

agent_home lead session `lead_1734170510bc9eda77fd0acd`. User asked "What
does the Snooze button do?" with uiContext `[app context: page / · last
active: button "Snooze"]`.

| Metric | Value | Source |
|--------|-------|--------|
| `first_token_ms` | 558,359 (~9m18s) | `[agent-home] turn-timing` (`hermes_cli/web_server.py` ~L13273) |
| `total_ms` | 560,631 | same |
| `tools` | 12 | same — the agent grepped the repo checkout 12× instead of using app-mcp |
| Compression passes | ~14 × 30–60s | `agent.log` lines ~18845–18862, 00:31:00–00:40:17 window |
| Real prompt size | `in=~132,000–137,000` | `api_call_log` usage records |
| Rough estimate | ~150–160K | preflight `estimate_request_tokens_rough` logs |

The final answer pointed at the then-current `SNOOZE_HOURS = 2` in
`agent-home/src/lib/suggested-tasks/channels.ts` (now `SNOOZE_OPTIONS`,
`channels.ts` L73, after #1095 landed today — the incident predates it).

## Root cause (verified against `origin/develop` @ 88961c2a6)

**Wrong window, wrong direction, nothing fixes it up.**

- `agent/context_compressor.py::_compute_threshold_tokens` (L872–911):
  `floored = max(int(effective_window * threshold_percent), MINIMUM_CONTEXT_LENGTH)`
  (L903). Box config has `compression.threshold: 0.2` (schema default 0.50
  at `hermes_cli/config.py` L1495), but the `MINIMUM_CONTEXT_LENGTH = 64_000`
  floor (`model_metadata.py` L185) makes the effective threshold **64,000**
  on the assumed 128,000 window.
- `agent/model_metadata.py::get_model_context_length` (L1780): resolution
  order is config → persistent cache → probes → hardcoded catalog
  (documented L1789–1810). On the custom alibaba token-plan endpoint the
  probes failed, logged "defaulting to 256,000 (probe-down)" (L1987–1992),
  then the catalog fallback (L2000–2012, longest-key-first) matched bare
  `"deepseek"` → **128,000** (`DEFAULT_CONTEXT_LENGTHS` L248) for model
  `deepseek-v4.1-flash` — the `deepseek-v4-flash`/`deepseek-v4-pro` 1M
  entries (L244–245) don't substring-match the `v4.1` slug.
- The endpoint then **accepted** `prompt_tokens ≈ 132–137K` — proof the
  128K assumption is low. `update_from_response` (L1040–1052) records the
  usage and never re-derives `context_length` upward. There is a downward
  path (`get_context_length_from_provider_error`, conversation_loop.py
  L3460, persisting via `save_context_length` at L2028–2034) and no upward
  path. One-directional learning ratchets down only.
- `estimate_request_tokens_rough` overestimates (~150–160K vs ~133K real —
  it intentionally pads schema-heavy requests, see the docstring at
  `should_defer_preflight_to_real_usage` L1054–1063), so the preflight gate
  (`agent/turn_context.py` L337–439) and the post-response gate
  (`conversation_loop.py` L4664–4695) both keep seeing "over threshold".

**Why the ~14 passes never converged.**

- The repeated firing happened on the **post-response path**: after each
  tool-call API response, `should_compress(_real_tokens)` at
  `conversation_loop.py` L4686 sees `last_prompt_tokens ≈ 133K ≥ 64K` and
  runs `_compress_context` → one `_generate_summary` LLM call (~30–60s on
  that endpoint). Each pass merges 1–2 of ~99 messages, real tokens stay
  ≥64K, and the next tool-call response re-fires it.
- `max_compression_attempts = 3` (L1024) is a **per-error-streak** cap
  inside the API-retry loop; `compression_attempts` resets to 0 on every
  successful response (L1058, L1396, L1469, L1618, L1794, L3137, L3170,
  L3655, L3811). Successful calls were happening — so the cap never binds.
- The anti-thrash guard (`should_compress` L1124, skips after
  `_ineffective_compression_count >= 2`) is armed by
  `savings_pct < 10` measured against the **rough** `display_tokens`
  (L2687, L2951–2960). Against a ~150K inflated baseline a pruning+merge
  pass can still log ≥10% "savings" — resetting the counter at L2960 —
  while real `prompt_tokens` never drop below threshold. The guard
  measures the estimator's error, not convergence.
- Gateway session hygiene (`gateway/run.py` L10686–10700) already prefers
  `session_entry.last_prompt_tokens` (stored L11706) over the rough
  estimate for exactly this reason — the in-loop gate does the same, but
  the **preflight** path still leads with the rough estimate.

## Design

### 1. Context length becomes observed-truth driven, per `(model, base_url)`

The cache key is already `model@base_url` (`save_context_length`,
`model_metadata.py` L945–963) — correct by design: the same model name on
two endpoints can serve different windows, and the key follows whichever
LLM is actually serving, including `fallback_providers` entries
(`config.py` L946) and mid-session model switches (`update_model` already
resets per-model calibration at `context_compressor.py` L825–845; the new
model's first response re-derives from **its own** cache entry at
`get_model_context_length` step 1, L1869–1870).

**a. Upward learning (new).** In `ContextCompressor.update_from_response`
(L1040): when `usage.prompt_tokens > self.context_length`, the provider has
proven the assumed window too small — an accepted request is a hard lower
bound. Then:

- compute `learned = get_probe_tier_above(prompt_tokens)` — a new ~5-line
  sibling of `get_next_probe_tier` (L989–994) returning the smallest
  `CONTEXT_PROBE_TIERS` entry `> prompt_tokens` (e.g. 133K → 256K), or
  `prompt_tokens` rounded up to a sane bound when above every tier;
- `save_context_length(model, base_url, learned)` — persists to the same
  cache `get_model_context_length` consults at step 1, so the correction
  survives restarts and applies to future sessions;
- update `self.context_length` + recompute `self.threshold_tokens =
  _compute_threshold_tokens(...)` in place, mirroring what
  `update_model` does at L814–820 (threshold, `tail_token_budget`,
  `max_summary_tokens` all derive from `context_length`).

Mirror the same write in the gateway hygiene store
(`session_entry.last_prompt_tokens` → `save_context_length` when it
exceeds the resolved window) so cron/gateway sessions learn too.

**Guardrails:**

- **Explicit config always wins.** When `model.context_length`
  (or `custom_providers` per-model) is set — the `config_context_length`
  param at `context_compressor.py` L924 — upward learning is disabled
  entirely and the cache is not written. Today the param is consumed at
  L955 and not stored; store it as `self._config_context_length` so the
  check is cheap (the agent also keeps it at `agent._config_context_length`,
  `agent_init.py` L1718).
- Only ever raise, and only on real `usage.prompt_tokens` from a
  successful response — never on rough estimates, never on error paths.
- One log line per learning event: `Learned context length upward:
  128,000 → 256,000 for deepseek-v4.1-flash@<base> (provider accepted
  in=137,xxx)`.

**b. Downward learning (exists, keep).** Provider-reported limit parsing
(`parse_context_limit_from_error` L997 / `get_context_length_from_provider_error`
L1025) → `update_model` step-down → `save_context_length` when
`_context_probe_persistable` (`conversation_loop.py` L3460–3491,
L2028–2034), plus `_invalidate_cached_context_length` (L973) for stale
entries. Document as the complementary direction: downward learns from
*rejected* requests, upward from *accepted* ones. Together they bound the
true window from both sides.

### 2. Loop dampeners (the actual latency fix)

**a. Per-turn cap on LLM-summary passes.** Track
`turn_llm_compression_passes` on the compressor, reset at turn start
(turn_context entry) and incremented inside `compress()` where
`_generate_summary` is invoked. Cap: **3** (matches the existing
`range(3)` preflight loop at `turn_context.py` L400 and
`max_compression_attempts` at `conversation_loop.py` L1024 — one shared
semantic, now per-turn instead of per-streak). When the cap is hit,
allow **one** deterministic no-summary pass — `_prune_old_tool_results`
(L1139) + oldest-window drop with the existing static handoff marker
(the `abort_on_summary_failure` fallback path already does this,
L947–951) — or proceed uncompressed and log a warning. Hard budget:
never spend >~2 min compressing inside a user turn.

**b. Non-convergence suppression.** Extend the anti-thrash rule: if a
pass shrinks the **re-estimated request size** by <5% and the estimate
still ≥ threshold, suppress further LLM passes for the rest of the turn
(deterministic prune may still run). This is the per-turn version of
`_ineffective_compression_count` — but measured against the
post-pass re-estimate (`_compression_made_progress` already computes
this at `turn_context.py` L429–431) rather than a stale baseline, so a
reset-on-inflated-baseline can't defeat it.

**c. Prefer `last_real_prompt_tokens` on the preflight path.** Where a
real provider count exists for the current model, gate preflight on it
(or `max(rough, real)` capped behavior) before paying for LLM passes —
mirroring gateway hygiene's documented priority order
(`gateway/run.py` L10694–10699). `should_defer_preflight_to_real_usage`
(L1054) already moves this way; extend it so a real count under
threshold suppresses preflight compression even when the rough estimate
is over — the incident's exact configuration.

**d. Cheap prune first.** `_prune_old_tool_results` already runs as
Phase 1 inside `compress()` (L2690). Keep that ordering and make the
cap-check happen *after* the prune's re-estimate so a pass that pruning
alone resolves never spends an LLM call.

### 3. Self-test / regression guard ("performance is maintained")

**a. Permanent latency ledger.** Extend the two existing timing lines:

- `[agent-home] turn-timing` (`hermes_cli/web_server.py` L13273): add
  `compress_passes`, `compress_ms`, `compress_ineffective`.
- `session-turn-timing` (`gateway/session_chat.py` L189): same fields.

A nightly/weekly check — the box already runs `hermes-drift-check.timer`
(referenced in `deploy/hermes-deploy.sh` L26) and the in-repo precedent
is `deploy/hermes-review-pass.timer` — scans the ledger and flags turns
with `compress_ms > 60s` or `compress_passes > 3`, filing a Needs-You
card via `needs_you.push_new` (`hermes_cli/needs_you.py` L1162).

**b. Unit invariants (pytest, behavior contracts — not snapshots):**

- preflight + in-loop LLM compression passes per turn ≤ 3;
- a pass below the convergence floor (<5% shrink, still ≥ threshold)
  does not re-fire within the turn;
- `update_from_response` with `prompt_tokens > context_length` raises
  `context_length` + `threshold_tokens` and writes the `model@base_url`
  cache entry; with `prompt_tokens ≤ context_length` nothing changes;
- explicit `model.context_length` config ⇒ upward learning is a no-op;
- a model switch mid-session (`update_model`) re-derives from the new
  model's own cache entry, not the old model's learned value;
- `compression.threshold: 0.2` on a learned-256K model yields threshold
  ≥ `MINIMUM_CONTEXT_LENGTH` only when that's below the window — i.e.
  the floor no longer manufactures a 64K trigger under a window we've
  proven is bigger.

**c. Optional canary: `hermes selftest latency`** (new CLI subcommand,
config-gated cron). Fresh session, trivial prompt, measure TTFT against
each configured provider + `fallback_providers` entry; on SLO breach
file a Needs-You card via `needs_you.push_new` — same channel as (a).

### 4. Deliberately NOT proposed

- No change to `compression.threshold` semantics or the
  `MINIMUM_CONTEXT_LENGTH` floor itself — the floor is correct once the
  window is right; the bug was the window.
- No per-session user override of context length.
- No change to summary prompt/quality, `summary_target_ratio`, or the
  protected head/tail policy.
- No env vars — new flags go in `config.yaml` under `compression.*`.

### 5. Rollout

| Flag | Default | Rationale |
|------|---------|-----------|
| `compression.learned_context` | `true` | It only corrects **provable** errors (accepted-request floor). Downward learning already persists the same way; symmetric default. |
| `compression.max_turn_llm_passes` | `3` | Matches existing per-streak caps; 0 = unlimited (escape hatch). |
| `compression.turn_llm_budget_ms` | `120000` | Hard wall per turn; deterministic prune unaffected. |

Migration safety: upward learning never lowers a window and never
touches explicit config; on first run with a stale-low cached value the
first accepted oversized response corrects it (the incident scenario
self-heals). Downward learning is unchanged. A wrong upward learn can
only over-estimate headroom, which the existing provider-error step-down
already bounds.
