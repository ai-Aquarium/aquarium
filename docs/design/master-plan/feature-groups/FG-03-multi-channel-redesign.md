# FG-03 — Multi-channel redesign (one brain, all channels)

**Wave:** 1 · **Status (2026-11-16):** **Re-scoped — P0 done, P1–P8 pending.** Gateway C4 identity enrichment is live; triage still runs in the standalone `custom/*` DeepSeek pipelines. See *Current state* and *Target design* below. Previous status: Contract + Shape-1 merged; **live-gateway wiring (C4 identity enrichment in `gateway/run.py`) IMPLEMENTED** — see *Gateway migration* below. Telegram live-tested; WhatsApp/email **live round-trip still pending** the channel creds (email = old-box Gmail IMAP; WhatsApp = QR bind).

## Summary
Route **every** incoming channel (N WhatsApp numbers, N emails, N calendars, …)
through the **one shared `AIAgent` loop** — the same skills/memory/context —
instead of the bespoke `custom/*` scripts that bypass the agent core today
("unified storage, siloed cognition" → "one brain, all channels"). This FG is
already designed in depth in **`docs/design/architecture-design-number-one.md`**
and **`docs/design/AGENT-HANDOFF.md`**; that design is authoritative — this doc
is the execution wrapper.

## Current state (verified on `develop`, 2026-11-16)

Full evidence with `path:line` citations:
[storage scoping audit](FG-03-audit/2026-11-16-storage-scoping.md) ·
[pipeline & gateway audit](FG-03-audit/2026-11-16-pipeline-gateway.md).

- **Two inbound systems that share no code.** (a) `custom/` pipelines:
  poll → SQLite → batch → one direct DeepSeek call → `triage_handlers`.
  (b) The gateway runs real `AIAgent` turns, but only for paired/allowed
  senders and for a person talking to their own bot/bridge. No triage runs in
  an agent.
- **Pipelines are not profile-aware.** Paths are hard-coded under `/opt/data`
  (outside every profile home); `hermes_cli` helpers they call resolve the one
  `HERMES_HOME` / prod schema from their env file.
- **Triage skills are box-wide** (`/opt/data/skills/<channel>-triage`,
  email also reads WhatsApp's). No profile or user layer.
- **Sources are scattered:** box-wide `config.json` (email accounts, WA
  phones), per-profile `credentials` rows (mailboxes, Google, one Telegram bot
  per user), per-profile `bridge-owners.json`, per-profile `account_owners`.
  Owner falls back Settings → config → saver → install owner.
- **Personal mailboxes are never triaged** (only mirrored into
  `inbound_items`) and cannot be replied from (`send_message_tool` resolves
  only pipeline-config accounts).
- **Double readers are possible:** a WA bridge in both the batcher config and
  `bridge-owners.json`; an inbox read by both the poller and the gateway email
  adapter.
- **Memory:** per user within a profile already exists
  (`memories/users/<uid>/MEMORY.md`); `INBOX_FACTS.md` is per profile and
  owner-only, so members' facts are lost.
- **Bugs found:** triage auto-start looks the to-do up as the install owner
  (skips for other people's arrivals); the WA/email digest goes to the box
  Telegram chat only; a failing triage batch is retried forever.
- **Outbound is in place:** approval → `execute_proposal` →
  `send_message_tool --account`, never auto-approved (review/reply-loop
  milestones A–D).
- **Reusable seam:** `agent.seeded_session.spawn_seeded_session(...,
  profile_home=, internal_user_id=)` runs a headless turn in a given profile
  as a given person.

## Target design (2026-11-16, approved by Yan) — multi-user, multi-profile, one routing call

Supersedes the single-profile framing above ("one profile for everything",
`architecture-design-number-one.md` §0.5). That framing was right for one
person; Aquarium now serves several people, each using several profiles.

### Model

| Concept | What it is | Stored |
|---|---|---|
| **Profile (template)** | A role such as CFO or CMO: Soul, model, skills, default triage skills | Its folder (`HERMES_HOME`, `profiles/<name>/`) + its own Supabase app schema (FG-27) |
| **User-profile** | One user using one profile. John and Mary can both use CFO; each starts from the template and keeps their own changes | A `principals` row in that profile's schema + (new) `<profile home>/users/<user_id>/` for the user's triage skills, memory and settings |
| **Source** | One incoming account: a mailbox, a WhatsApp number, a Telegram bot | Box-wide list; **exactly one owner user**; a second user claiming the same address/number is refused |
| **Route** | Source → one of the owner's user-profiles (John's mailbox → John@CFO, John@CMO). The owner decides; a profile with no route never reads that source and costs nothing | Box-wide, next to the source |

Each source is connected **once** (one poller/bridge/bot), never once per
profile: gateway adapters take a scoped credential lock
(`acquire_scoped_lock`) so two profiles cannot hold the same credential.
Fan-out to profiles happens after the router, not by connecting the source in
every profile.

Not supported: one mailbox shared by several people (e.g. `info@`).

### Flow per incoming batch

1. A source's poller/bridge/bot receives a batch (as today's batchers debounce).
2. **One routing call** per batch: a cheap model reads the batch plus the
   owner's "What I care about" section from each routed user-profile and
   returns 0..N user-profiles with a one-line reason each. Zero → stored only.
   The decision and reasons are recorded ("Why this profile?").
   On failure: wait and retry 3 times, then send to **all** routed
   user-profiles.
3. **Full triage** in each chosen user-profile: a headless turn of that
   profile's agent, acting as the owner, with skill layers
   built-in defaults → profile template → user's version. The response schema
   and `custom/shared/triage_handlers.py` stay; outputs (to-dos, escalations,
   work requests, memory facts) land in that profile's schema and the user's
   sub-folder.
4. Needs You merges alerts that several profiles raise for the same arrival.
5. Replies leave via the receiving account and always need approval.
   Auto-send is designed for (a per-user-profile setting) but off.

### Onboarding and editing

- Registering a source: pick which of my profiles it routes to, then for each
  "Use the template's triage skills" or "View and change".
- Later: Profile › My triage skills — template beside my version, diff,
  Reset to template, history.
- Profile owners/admins edit the template; each user edits only their own
  version. A user's version overrides whole files, adds files, or disables
  files (no line-level merge).

### Phases

| Phase | Deliverable | Effort |
|---|---|---|
| **P0** | This rewrite + verified current-state audit; system test points at `PRODUCTION.md` in `leolau/aquarium-ops` | 1 d |
| **P1** | User-profile folders `<profile>/users/<user>/`, created on enrolment, archived on removal; isolation tests | 2 d |
| **P2** | Source registry: one owner per source (unique), routes to the owner's user-profiles; migrate today's mailboxes, WhatsApp phones/bridges, Telegram bots; unowned → install owner; conflicting claims listed for the owner | 3–4 d |
| **P3** | Triage skill layers per user-profile; required "What I care about" section; reset + history | 2–3 d |
| **P4** | Router: one cheap call per batch, configurable model, stored decisions, retry ×3 then all | 2–3 d |
| **P5** | Full triage in the chosen user-profiles' agents; per-channel switch `legacy|agent` with a comparison period before cutover; Needs You dedupe | 4–5 d |
| **P6** | Telegram as a triage source; replies from the receiving account, approval-only | 2 d |
| **P7** | UI — Figma mockups first, then agent-home: register-source wizard, My triage skills, "Why this profile" | 1.5 d + 3–4 d |
| **P8** | Real-Postgres E2E (John & Mary × CFO & CMO; routed to one / both / none; fallback; ownership uniqueness; no cross-user leaks), browser test, production test on approval | 2–3 d |

### Design notes from the audit

- **Box-level registry.** Sources, routes and routing decisions must live
  outside any one profile schema (today credentials are profile-schema-bound
  and the FG-27 guard refuses foreign schemas). P2 decides the store (a
  box-level schema next to GoTrue, or the default profile's schema with
  explicit box scope) and how a source credential is read without entering a
  profile schema.
- **One reader per source.** P2 removes the double-reader paths: the
  pipeline poller/batcher is the only reader of a triaged source; the gateway
  keeps the owner's self-chat on person bots/bridges.
- **User folder.** `<profile>/users/<uid>/` holds triage skills and
  settings; per-user memory stays at `memories/users/<uid>/` (already per
  user-profile) to avoid a migration. `users/` must be added to the
  `--clone-all` / export excludes and to the user-removal sweep.
- **Triage results** go to the chosen profile's schema (`inbound_items`,
  to-dos, notifications, a per-user `INBOX_FACTS`), not the box-wide SQLite,
  which keeps raw messages keyed by source.
- **Telegram:** allow several bot sources per user (today one fixed `bot`
  credential). The owner's self-chat with a person bot/bridge needs a default
  user-profile.
- **Prompt cache:** each triage run is a seeded session; keep each
  user-profile's triage system prompt byte-stable (skill layers resolved at
  session start) so provider prefix caching applies.

### P5 — switching a channel to the user-profiles' agents

Each channel has its own switch in `config.yaml` (default `legacy`):

```yaml
triage:
  router:
    mode: shadow        # off | shadow | enforce; agent mode needs shadow or enforce
  agent:
    email: legacy       # legacy | shadow | agent
    whatsapp: legacy
```

- `legacy`: today's box-wide DeepSeek triage acts, nothing else runs.
- `shadow`: legacy triage acts exactly as today; afterwards every picked
  user-profile's agent triages the same batch and the result is only stored in
  `aquarium_box.triage_comparisons` next to the legacy verdict. Shadow
  failures never touch the legacy path.
- `agent`: only the picked user-profiles' agents act. Each pick's result goes
  into that profile, for the batch's owner (`process_result(...,
  profile_home=, owner_user_id=)`); the box-wide SQLite channel rows (tasks,
  notes, escalations) are written once per batch (`box_writes=True` for the
  first profile only). No pick → stored only. No `source_id`, no decision
  (registry down) or `triage.router.mode: off` → legacy triage. A profile whose
  turn fails is retried on the next pass; the batch file keeps
  `_profiles_done` / `_agent_attempts` so only the failed ones rerun, and after
  3 failed passes the batch falls back to legacy triage. The legacy result is
  acted on only in the profiles that never succeeded, as the batch owner
  (box-wide rows still once); a profile that no longer exists is skipped. Only
  when no profile succeeded and none resolves does the legacy result go to the
  default profile as before.
- The shortcuts (email newsletter, WhatsApp seminar survey and media-only)
  never route and never run a turn. Calendar stays legacy: its events carry no
  `source_id` and are not routed yet (P4 did not wire calendar).
- Code: `custom/shared/batch_routing.py` (`route()` → `Outcome(triage,
  decision, mode)`, one router call per pass), `custom/shared/profile_triage.py`
  (the switch), `hermes_cli/triage_agent.py` (the per-profile turn and
  comparisons).

**Comparison period runbook (per channel).**
1. Router first: `triage.router.mode: shadow` and check
   `hermes source decisions` picks the right user-profiles.
2. Set `triage.agent.<channel>: shadow`; restart that channel's triage
   service (it reads `config.yaml` at start).
3. Review for a few days: `hermes source comparisons --as <user> --source
   <channel>:<address>` (or `--all` as box admin; `/api/sources/comparisons`
   in agent-home) — escalate/classification agreement, extracted to-dos, and
   failed turns. Ask each owner to fix their "What I care about" or triage
   skills where the agent is wrong.
4. Cut over: `triage.agent.<channel>: agent`, restart. Watch the first
   batches land in each picked profile (Incomings, to-dos, Needs you) and that
   no batch sits in the batch dir with `_agent_attempts`.
5. Roll back any time by setting the channel back to `legacy` (or `shadow`)
   and restarting; batches already processed are not replayed.

## Decisions applied
- D7 (`session_key` gains `account_id` + user/task), D5 (channels prod-only), D2 (hybrid memory for shared coordination state).

## Reuse map
- `gateway/session.py` `build_session_key` / `SessionSource` — extend with `account_id` (C4).
- `gateway/run.py` — per-`session_key` cached `AIAgent` (already exists — "Cache AIAgent instances per session to preserve prompt caching"); N accounts/conversations = N cores, one profile.
- `custom/{whatsapp,email,calendar}/*` pollers/batchers — **keep as thin producers**; strip bespoke DeepSeek triage.
- `gateway/platforms/*` adapters — the Shape-2 durable target (N adapter instances per account).

## Design / approach (from design #2)
1. **C4 — add `account_id` (receiving-inbox identity) to `SessionSource`** and
   fold into `session_key` so per-account conversations don't collide and
   **egress replies leave via the correct account**. Must remain
   **byte-identical for existing single-account callers** (locked by
   `tests/plan_baseline/test_session_key_baseline.py`).
2. **Shape 1 (first):** producers push normalized events
   `(platform, account_id, sender_chat_id, payload)` into an **in-process
   inbound queue** in the gateway → bounded async worker pool → each worker
   owns one session's cached core. Reuse working pollers; no adapter rewrite.
3. **Shape 2 (durable):** teach the gateway to run **N adapter instances, one
   per account** (extend `PlatformConfig` with `accounts:`). Migrate after
   Shape 1 proves out.
4. **Calendar = cron/heartbeat producer** into the same queue.
5. **Channels are PROD-ONLY** (D5/C3 guard).

## Gateway migration (Shape-1 → live `gateway/run.py`)
**Status: IMPLEMENTED (code); live channel round-trip pending creds.** Shape-1
first landed the router/producers as a *contract with tests*
(`gateway/inbound.py` `InboundRouter`, `gateway/producers.py`). The live gateway
is now wired to realise the same contract at runtime.

**Design decision (why not a second `InboundRouter` instance in the loop).** The
live gateway *already* implements the `InboundRouter` semantics: one cached
`AIAgent` per `session_key` (`_agent_cache`), per-session **serial** turns
(`_running_agents` + the session interrupt/owner-task guards), and
cross-session **parallel** dispatch. Bolting a second in-process queue in front
of it would duplicate that machinery and add a hand-off hazard. What the live
path was actually missing was the **C4 identity**: it never stamped the
receiving `account_id` or resolved the sender to an internal `Principal`, so
every channel keyed purely on the raw handle. The migration therefore wires the
**identity enrichment** — not a parallel queue — into the one inbound
chokepoint, so `build_session_key` folds in `account_id`/`internal_user_id` and
the existing cache/serialisation gives us the one-brain, per-internal-user
behaviour. `InboundRouter`/producers remain the canonical Shape-1 contract
(and the entry point for out-of-process producers / Shape-2).

**Goal (met at the code level):** every channel turn keys on
`session_key = f(channel, account_id, internal_user, task)` (C4) with the
channel sender bound to an internal `Principal` (C1) and channel origin forced
prod (C3), and egresses via the receiving `account_id`.

**Verifiable checklist (Definition of Done for the migration):**
- [x] `gateway/run.py` enriches the inbound `SessionSource` at the single
      chokepoint (`_handle_message_with_agent`) via
      `_enrich_channel_source_identity` — stamps the receiving `account_id`
      (from the adapter) and resolves the sender→internal `Principal` through
      the C1 `bind_channel_principal` seam (`_get_principal_store`), **before**
      the session key / cached-`AIAgent` lookup, replacing raw-handle-only
      keying. (Realises the `InboundRouter` contract on the gateway's existing
      per-session-serial / cross-session-parallel cached-agent dispatch — see
      *Design decision* above — rather than adding a second queue.)
- [x] The receiving `account_id` comes from the adapter
      (`BasePlatformAdapter.account_id`, config-driven via
      `platforms.<p>.account_id` / `extra.account_id`, `None` by default); no
      adapter runs its own LLM/DeepSeek triage (reasoning happens once in the
      shared core). Producers (`normalize_whatsapp`/`_email`/`_message`) remain
      the normaliser API for out-of-process / Shape-2 feeds.
- [x] Egress routes back through the originating `account_id` — in Shape-1 the
      reply leaves via the same adapter that received it, and distinct
      `account_id`s produce distinct `session_key`s / cached cores (unit-tested
      for ≥2 accounts, same sender).
- [x] **Per-user pairing/enrollment:** a WhatsApp sender / email `from_address`
      resolves to an internal `Principal` (auto-enrol when pairing-approved via
      `gateway/pairing.py`); unpaired identities fall back to channel-identity
      keying (documented, not silently shared). Gated: no-op when the app DB
      DSN is unset, so single-account deployments keep byte-identical keys.
- [x] Prompt-cache safety preserved: reuses `gateway/run.py`'s existing
      per-`session_key` cached `AIAgent`, frozen system prompt, strict role
      alternation, per-session serial / cross-session parallel drain — the
      enrichment only adds additive key dimensions, it does not touch the
      prompt/toolset or message sequencing.
- [x] Tests: `tests/gateway/test_live_gateway_identity_wiring.py` (account_id
      stamping, two-account isolation, no-op gating, C1 principal resolution,
      error fall-back, DSN gate) + the existing Postgres E2E
      (`test_inbound_principal_e2e.py`) for real principal binding + negative
      access. `scripts/run_tests.sh`, `ruff`, `ty`, baseline all green.
- [ ] **System test on `hermes-systest`:** live WhatsApp round-trip (paired
      number → shared brain → reply out) and live email round-trip
      (inbox → shared brain → reply out), plus the two-account isolation +
      channel-prod guard checks from the *System testing* section, run on the
      deployed box. **Pending channel creds** (email = old-box Gmail IMAP
      app-passwords; WhatsApp = QR bind). Record evidence.

**Non-goals here:** Shape-2 (N durable adapter instances per account via
`PlatformConfig.accounts:`) remains a later step; this migration wires the C4
identity into the live gateway's existing dispatch.

## Data model
- `SessionSource.account_id` (additive). Shared coordination state (in-flight / handled / dedupe / per-lead status) lives in the FG-05 **live** store, read via tool call (cache-safe).

## Dev/Prod + Supabase
Channel ingestion forced to `prod` (C3 guard, tested). Coordination state in `app_prod`.

## Testing requirements
- **Regression lock:** `build_session_key` byte-identical for single-account callers (baseline suite).
- Unit: `account_id` isolates two accounts' conversations; egress routes to correct account.
- E2E: two accounts → two isolated cores under one profile; a message on account A and account B don't cross-contaminate history.
- Channel prod-only guard test.

## System testing (system-test box)
> **Superseded 2026-11-16:** the box named below is decommissioned. Run system tests on production only with approval, following `production/PRODUCTION.md` in `leolau/aquarium-ops`. Target scenarios are in *Target design › Phases* (P8).

**Required step after this FG's development completes** (part of its Definition of Done), on top of the per-PR unit/E2E + baseline gate: deploy this FG to the new ai-prentice-4-all ECS (`hermes-systest`, `i-j6c81aisv2dd8mg17yle`, 4/16, cn-hongkong-b, EIP `47.83.199.25`) — the dedicated **system-test host** — and exercise it end-to-end on the real stack against a **staging** Supabase schema (`app_staging`) + staging SQLite core (**never prod**). See README §7.1. Acceptance checklist:
- Bind ≥2 real **test** channel accounts (e.g. 2 WhatsApp numbers / 2 email inboxes) on the deployed box; confirm both route into the **one shared brain**, sessions stay isolated per account, and replies egress via the correct account.
- Exercise the **channels-prod-only** guard on the live stack (channel traffic never resolves to dev/staging mode).
- Confirm shared coordination state is read via tool call (cache-safe) across the two accounts — no system-prompt mutation.
- **Gate:** this FG is not complete/promotable until this ECS checklist passes (on top of the per-PR gate).

## Dependencies
- **Blocked by:** FG-13 (C3), FG-05 (hybrid memory for coordination state).
- **Blocks:** FG-06 (task discovery from convo), FG-09.
- Publishes contract **C4** early in Wave 1.

## Definition of Done
Tests green + baseline green (session-key lock intact) + `ruff`/`ty` clean; Shape 1 in-process queue works E2E for ≥2 accounts; design-doc principles upheld (one brain, cache-safe); **ECS system test green**.

## Progress checklist
- [x] `SessionSource.account_id` (+ `internal_user_id` / `task`) + `session_key` fold-in (C4), single-account byte-stable
- [x] In-process inbound queue + bounded worker pool (Shape 1) — `gateway/inbound.py` `InboundRouter` (per-session serial, cross-session parallel); used only by tests, the live gateway uses its own agent cache by design
- [ ] Producers stripped to thin normalizers (WhatsApp/email/calendar) — `gateway/producers.py` exists but is **test-only**; `custom/*` still triages via DeepSeek (corrected 2026-11-16 → P4/P5)
- [ ] Calendar cron producer — `gateway/producers.py` `calendar_event_to_inbound` / `run_calendar_sync` exist but are **not wired**; calendar runs `custom/calendar/*` (corrected 2026-11-16)
- [x] Channel prod-only guard — `gateway/inbound.py` `guard_channel_prod` (routes via C3 `resolve_mode`); note: not called at runtime, the gateway hard-binds `app_schema("prod")` instead (effectively met)
- [x] Channel identity → Principal bound via the C1 `resolve_principal` seam — `gateway/inbound.py` `bind_channel_principal`
- [x] tests + Shape-2 migration notes (unit + Postgres E2E incl. negative-access; Shape 2 documented in `gateway/inbound.py` + Design §3)
- [x] **Live-gateway wiring (C4 identity enrichment in `gateway/run.py`)** — see *Gateway migration* section; the running gateway now stamps `account_id` + resolves the internal `Principal` at the inbound chokepoint (unit-tested). Live WhatsApp/email round-trip still pending channel creds.
- [x] System test on the system-test ECS — Telegram inbound→C4 route→DeepSeek→egress + web/Telegram parity **PASSED** (2026-07-11); WhatsApp + email live round-trip **still pending** (needs the gateway migration + channel creds)

### Target design phases (2026-11-16)
- [x] P0 — re-scope doc + verified current-state audit
- [ ] P1 — user-profile folders `<profile>/users/<uid>/`
- [ ] P2 — box-level source registry, one owner per source, routes
- [ ] P3 — triage skill layers per user-profile
  - [x] Layers built-in → template `<profile>/triage-skills/<kind>/` → user `<profile>/users/<uid>/triage-skills/<kind>/` (`hermes_cli/triage_skills.py`): add/override/disable, reset + history, required "What I care about" (≤4 KB, user → template → built-in); email built-ins keep both `whatsapp-triage/` and `email-triage/` keys; symlinks cannot escape a layer
  - [x] Router input for P4: `triage_skills.care_sections_for_source(conn, source_id)` — one care entry per enabled route, the source owner's own layer (Telegram: none yet); real-Postgres E2E (John's mailbox → John@CFO + John@CMO, never Mary's)
  - [x] Profile lifecycle: `--clone` / `--clone-all` / export carry `triage-skills/` (no `.versions/` on `--clone`), never `users/`; skill discovery never loads `triage-skills/` (`tests/hermes_cli/test_triage_skills_profiles.py`)
  - [ ] API/CLI + agent-home "My triage skills" (P7)
- [ ] P4 — router (one cheap call per batch, retry ×3 then all)
  - [x] Core `hermes_cli/triage_router.py`: `auxiliary.triage_router` call, byte-stable system prompt (routes + care only), strict JSON reply (unknown profiles dropped), `triage.router` {mode shadow|off|enforce, retries 3, retry_delay_seconds 5} then all routed profiles `fallback=true`; `aquarium_box.routing_decisions` (reasons only, no batch text; idempotent per source+batch; owner-only, box admin `all=1`); `hermes source decisions`, `GET /api/sources/decisions` + agent-home BFF; real-Postgres E2E (`tests/hermes_cli/test_triage_router_e2e.py`)
  - [ ] Pipelines call `route_batch_sync` (shadow first)
- [ ] P5 — full triage in chosen user-profiles' agents (per-channel switch)
  - [x] Per-profile agent turn + comparisons store, `hermes source comparisons` (`hermes_cli/triage_agent.py`)
  - [x] Handlers act in a given profile for a given owner, box-wide SQLite once (`box_writes`), Needs You dedupe (`custom/shared/triage_handlers.py`)
  - [x] Pipelines: `triage.agent.<channel>` legacy|shadow|agent in the email and WhatsApp triage scripts (`custom/shared/profile_triage.py`, `batch_routing.route`), per-profile retry with `_profiles_done`, legacy fallback after 3 failed passes; calendar stays legacy (not routed); real-path E2E `tests/custom/test_fg03_profile_triage_e2e.py`
  - [ ] Comparison period per channel (runbook above), then cut over
- [ ] P6 — Telegram triage source; replies from receiving account
  - [x] (A) Gateway capture (`gateway/person_telegram_bots.py`): with `triage.agent.telegram: agent` and the person bot an enabled, routed `telegram` source in `aquarium_box`, other senders' DMs and group messages (refused by the adapter's `allow_from`, handed to `TelegramAdapter.set_refused_message_sink`) are written as `hermes_cli/telegram_triage.py` batch files — never an agent turn, never a reply; one chat per batch, written after `CAPTURE_QUIET_SECONDS` (20 s) quiet, at most `CAPTURE_MAX_SECONDS` / `CAPTURE_MAX_MESSAGES`; registry answer cached 60 s, fails closed (others ignored); owner DM unchanged; install bot unchanged; no raw box-wide mirror (WhatsApp's is a standalone-service SQLite path, not a gateway one). Media are described (file ids), not downloaded. Real-Postgres E2E `tests/gateway/test_person_telegram_capture_e2e.py`
- [ ] P7 — UI (Figma mockups first)
- [ ] P8 — E2E, browser and approved production verification

## Audit log
| Date | Edition | Author | Change | Rationale |
|------|---------|--------|--------|-----------|
| 2026-07-11 | 1 | devin:8cec0d47 | Created FG doc | Plan kickoff |
| 2026-07-11 | 2 | devin:8cec0d47 | Added System testing (system-test box) section as a per-FG DoD step | Leo: new 4/16 ECS = system-test host (+ prod for now), run after each FG's development |
| 2026-07-12 | 4 | devin:8cec0d47 | Added *Gateway migration (Shape-1 → live `gateway/run.py`)* section + checklist; corrected status/progress to reflect that the live gateway does not yet route channels through `InboundRouter` (only Telegram was live-tested; WhatsApp/email live round-trip pending migration + creds) | Leo: migrate the live gateway to the one-brain router first, then do live WhatsApp/email round-trips; document so future agents can follow/verify |
| 2026-07-11 | 3 | devin:733e4888 | Implemented C4 (`SessionSource.account_id`/`internal_user_id`/`task` + `build_session_key` fold-in, byte-stable for single-account callers) and Shape 1 (`gateway/inbound.py` in-process `InboundRouter` queue+bounded pool with per-session-serial / cross-session-parallel turns; `gateway/producers.py` thin WhatsApp/email/calendar normalizers + calendar cron producer). Bound channel identity → Principal via the C1 `resolve_principal` seam; channels forced prod-only via the C3 router. Added unit tests + Postgres E2E (≥2 accounts isolated, principal binding, negative-access); baseline + `ruff`/`ty` clean. | Publish contract C4 early in Wave 1 (FG-06/FG-09 depend on it); realise one-brain-all-channels without per-channel silos while preserving prompt-cache safety. |
| 2026-07-11 | 6 | devin:8cec0d47 | **Live-gateway wiring implemented.** Wired C4 identity into the running gateway: `_handle_message_with_agent` now calls `_enrich_channel_source_identity` (stamps receiving `account_id` from `BasePlatformAdapter.account_id`; resolves sender→internal `Principal` via `bind_channel_principal`/`_get_principal_store`) **before** session-key/cached-`AIAgent` lookup. Gated on the app-DB DSN (no-op / byte-stable when unset). Chose to enrich the gateway's *existing* per-session-serial / cross-session-parallel cached-agent dispatch rather than add a second `InboundRouter` queue (documented under *Design decision*). Added `tests/gateway/test_live_gateway_identity_wiring.py`; baseline + `ruff`/`ty` clean. Live WhatsApp/email round-trip still pending channel creds. | Leo: migrate the live gateway to the one-brain router first, then live WhatsApp/email round-trips; keep it followable/verifiable. |
| 2026-11-16 | 7 | devin:ee4fdc1b | Re-scoped FG-03 to multi-user / multi-profile: added *Current state* (audit), *Target design* (profile template + user-profile, one-owner sources, one routing call per batch, full triage per chosen user-profile), P0–P8 phases; corrected over-ticked checklist items; superseded the decommissioned system-test box | Yan approved the design 2026-11-16 |

## Cloud-agent prompt
> **Historical (Wave 1).** For new work, implement the next unticked phase in *Target design phases*, one PR per phase.

> **[Wave 1 — start after Wave 0 merges]** Repo `leolau/aquarium`, branch off `develop`. Read `docs/design/master-plan/README.md`, this doc (`FG-03`), and the authoritative designs `docs/design/architecture-design-number-one.md` + `docs/design/AGENT-HANDOFF.md`. Implement the **multi-channel redesign (one brain, all channels)**: (1) add `account_id` to `SessionSource` and fold it into `build_session_key` (contract C4) while keeping keys **byte-identical for existing single-account callers** — `tests/plan_baseline/test_session_key_baseline.py` must stay green; (2) build **Shape 1**: an in-process inbound queue + bounded async worker pool in the gateway, with the existing `custom/*` pollers reduced to thin producers emitting `(platform, account_id, sender_chat_id, payload)`, each routed to the per-session cached `AIAgent` (reuse `gateway/run.py`'s cache); (3) add a calendar cron producer into the same queue; (4) enforce **channels prod-only** via contract C3. Shared coordination state goes in the FG-05 live store via tool call (cache-safe) — never in the system prompt. Follow `AGENTS.md` (one brain/one profile, cache-sacred, footprint ladder). Add unit + E2E (≥2 accounts isolated) + prod-only guard tests; run `scripts/run_tests.sh`, `ruff`, `ty`. Edit ONLY this FG doc. Open a PR linking this doc. **Not done until this FG's *System testing (system-test box)* checklist (in this doc) passes** — coordinate that deploy/run with Leo.
