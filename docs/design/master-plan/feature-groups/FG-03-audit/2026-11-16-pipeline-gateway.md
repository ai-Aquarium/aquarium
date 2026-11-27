# FG-03 P0 — Task B: message pipeline & gateway audit

Repo `ai-Aquarium/aquarium`, branch `develop` @ `ea324d0937`. Read-only.
**V** = VERIFIED (I read the code at that line). **I** = INFERRED (reasoned from the code, or depends on box state I can't see).

## TL;DR
- **Two separate inbound systems exist and don't share code.** (a) The `custom/` pipelines are standalone processes: poll → SQLite → batch JSON → **one direct DeepSeek call** → `triage_handlers` → SQLite, registry and to-dos. (b) The gateway runs real `AIAgent` turns, but only for senders who are allowed and paired. No triage runs inside an agent today.
- **The pipelines don't know about profiles.** Every path is hard-coded under `/opt/data/...`. Skills come from `/opt/data/skills/<channel>-triage`. Anything that goes through `hermes_cli` (owner lookup, the to-do store, memory, `launch_todo_work`) uses whatever `HERMES_HOME` the systemd env file sets. That is the single install profile (I).
- **`owner_user_id` is attached at arrival registration, not in the batch.** Triage itself always runs as one generic prompt for the install. Ownership is looked up again from the registry when to-dos and escalations are written.
- **Personal mailboxes (Settings, credential store) are never triaged.** They are only mirrored into the registry.
- **The gateway has no per-user-profile notion.** Person Telegram bots and person WhatsApp bridges run in the *active* profile and stamp only `internal_user_id`. `multiplex_profiles` maps one adapter credential to one profile.
- **`gateway/inbound.py` `InboundRouter` and all of `gateway/producers.py` are only used by tests.** Only `bind_channel_principal` and `clamp_to_bridge_person` are used live. The FG-03 checklist overstates the state of the producers and the router.
- **Outbound:** approval → `execute_proposal` → `send_message_tool` with `--account` is implemented. Milestones A–D of the review/reply-loop plan are marked done, and the code matches.

---

## 1. `custom/` pipelines

### 1.1 Processes / units
| Item | Evidence | V/I |
|---|---|---|
| 15 long-running services: `hermes-gateway`, `hermes-dashboard`, `hermes-digest`, `hermes-escalation`, `hermes-wa-bridge-personal`, `hermes-wa-bridge-connectar`, `hermes-wa-batcher`, `hermes-wa-triage`, `hermes-email-poller`, `hermes-email-batcher`, `hermes-email-triage`, `hermes-embed`, `hermes-calendar-poller`, `hermes-calendar-triage`, `agent-home` | `docs/deployment/README.md:96-104` | V (doc) |
| Box HERMES_HOME = `/opt/data/hermes-home-staging` | `docs/deployment/README.md:70`; `deploy/hermes-review-pass.service:36` | V (doc/unit) |
| Only the calendar units are in git. Both use `EnvironmentFile=/opt/data/hermes-messaging.env` and `/opt/data/hermes-agent/custom/calendar/*.py` | `deploy/hermes-calendar-poller.service:14-20`, `deploy/hermes-calendar-triage.service:14-18` | V |
| The email/WA/escalation/digest units are **not in `deploy/`**. They live in the private deploy-state repo | `ls deploy/` (none present) | V for absence; their contents I |
| Per-person WA bridge template: `WHATSAPP_ALLOWED_USERS=*`, `FORWARD_OWNER_MESSAGES=1`, session `/opt/data/hermes-home/whatsapp/session-%i` (note: `hermes-home`, not `-staging`) | `deploy/hermes-wa-bridge@.service:12-21` | V |
| The pipelines' HERMES_HOME comes from `hermes-messaging.env`, which is not in the repo | `deploy/hermes-seminar-outreach.service:15-17` (comment: "Supplies HERMES_HOME") | I |

### 1.2 Email
| Step | Evidence | V/I |
|---|---|---|
| DB/config are `/opt/data/email-messages/{email_data.db,config.json}` (env-overridable) | `custom/email/email_poller.py:25-26` | V |
| Accounts read: enabled entries in the install config, plus personal mailboxes from `hermes_cli.email_mailboxes.all_mailboxes()` | `email_poller.py:46-63`, loop `669-718` | V |
| `account_owner()` = Settings › Accounts choice (`settings_owner('email', addr)`), else the entry's `owner_user_id`, else the credential's owner, else `None` (install owner) | `email_poller.py:247-261`; resolved per account at `298` | V |
| Every stored message → `register_item(surface='email', account_id, owner_user_id=…)`, plus attachments → file registry | `email_poller.py:441-460, 470-480` | V |
| **Personal mailbox messages are NOT written to `email_messages`, so they are never batched or triaged** ("the batcher, triage and email MCP read it as the install owner") | `email_poller.py:521-527, 545-560, 578-638` | V |
| Batcher: hard-coded `/opt/data` paths. Groups by `from_addr|account_id` and thread. Window `batching.window_seconds` (default 30). **The batch JSON has no owner field** | `custom/email/email_batcher.py:18-21, 53-80, 88-97, 129` | V |
| Triage `load_skills`: `triage.skills_dirs` (default `/opt/data/skills/whatsapp-triage` + `/email-triage`) plus a `custom/` subdir. Concatenates all `*.md` into the system prompt on every batch | `custom/email/email_triage_agent.py:35-36, 74-101, 136, 177-189` | V |
| Model: direct POST to `api.deepseek.com/v1/chat/completions`, `triage.model` (default `deepseek-chat`), `response_format=json_object`, temperature 0.3, wrapped in `/opt/data/track_credit_helper.track_inference` | `email_triage_agent.py:22-23, 44-58, 104-131` | V |
| VIP/family flags come from the messaging DB's `contact_handles`/`unified_contacts` (one set of contacts for the whole install) | `email_triage_agent.py:141-175` | V |
| Newsletter short-circuit (no LLM). On LLM failure the file stays in place and is retried **forever** (no cap, no fallback) | `email_triage_agent.py:300-336` | V |

### 1.3 WhatsApp
| Step | Evidence | V/I |
|---|---|---|
| Batcher polls each `config.phones[]` bridge (`bridge_port`, e.g. 3000/3001) via drain-on-read `GET /messages` | `custom/whatsapp/batcher.py:5, 30-33, 480-497`; `scripts/whatsapp-bridge/bridge.js:609-612` | V |
| `phone_owner()` = `settings_owner('whatsapp', id)`, else `phone.owner_user_id`, else `bridge-owners.json` by port | `batcher.py:183-206` | V |
| `register_item(surface='whatsapp', account_id=source_phone, owner_user_id)`, plus media registration | `batcher.py:317-329, 336-382` | V |
| Batch key `sender:source_phone`. The record has `is_family` but **no owner** | `batcher.py:402, 447-454` | V |
| Triage: `/opt/data` paths, `SKILLS_DIR=/opt/data/skills/whatsapp-triage`, the same `load_skills` pattern, DeepSeek direct | `custom/whatsapp/triage_agent.py:31-55, 70-128, 130-185` | V |
| Seminar survey short-circuit; family media → escalate without LLM; non-family media-only → ignorable | `triage_agent.py:265-310` | V |
| `custom/whatsapp/{escalation_pusher,telegram_callback_handler,contact_manager}.py` are byte-identical copies of the `custom/shared/` versions (`diff` clean) | — | V |

### 1.4 Calendar
| Step | Evidence | V/I |
|---|---|---|
| Owner = `settings_owner('calendar', email)`, else the credential owner | `custom/calendar/calendar_poller.py:159-167` | V |
| `register_item(..., keep_owner=True)`: an updated event keeps its earlier owner | `calendar_poller.py:363-386`; `custom/shared/inbound_registration.py:256-269` | V |
| Triage: `/opt/data/skills/calendar-triage`, DeepSeek direct, one call per event, `process_result` | `custom/calendar/calendar_triage_agent.py:26-38, 62, 149-194, 219-234` | V |

### 1.5 `custom/shared/triage_handlers.py`: what each response field does
| Field | Action | Line | V/I |
|---|---|---|---|
| `memory_facts` | `memory_bridge.remember_facts` → `$HERMES_HOME/memories/INBOX_FACTS.md` (one file for the profile, not per user) | `41-57`; `memory_bridge.py:6, 77-95` | V |
| `tasks` | INSERT into `wa_tasks` / `email_tasks` (SQLite) | `64-100` | V |
| `todos` | `register_todo` (staged, or open if `notify`), linked to the first arrival | `103-157` | V |
| `work_request` | `register_todo(notify=True, origin='triage')`. Auto-starts at most one per batch, only if the skill sets `auto_start` **and** `triage.auto_work` is set in the channel `config.json` | `161-235`, gate `238-263` | V |
| (auto-start) | `_auto_start` uses `resolve_owner()` (the **install owner**), then `store.get(principal, todo_id)` → `set_stage('working')` → `launch_todo_work` | `266-301` | V |
| `notes` | `wa_notes` / `email_notes` | `303-337` | V |
| `escalate` | INSERT into `escalations` (with reason/priority/summary merged from the result) | `340-395` | V |
| `importance`, `importance_reason`, `prep_notes` | UPDATE `calendar_events` | `402-447` | V |
| *(all)* | `stamp_inbox_importance` → `mark_importance` on registry arrivals (attention reason: escalated / critical_event / todo) | `454-562` | V |
| Dispatcher | merges the result into the batch, calls each registered handler, ignores unknown keys | `569-602` | V |

**Risk (I):** `register_todo` files the to-do under `arrival_people(...)[0]` (`todo_registration.py:174-194`). `_auto_start` then looks it up as the install owner (`triage_handlers.py:285-289`). For a non-owner's arrival, the owner-scoped `store.get` can return `None`, so auto-start silently skips. The cause is row scoping in `todo_store`, which I didn't read.

### 1.6 Where outputs go
| Output | Mechanism | Evidence | V/I |
|---|---|---|---|
| Who owns an item | `owner_routing.resolve_people` → `registry.owners_for_many`. Unregistered arrival → install owner. Inactive person → nobody | `custom/shared/owner_routing.py:48-100` | V |
| Escalation push | `escalation_pusher_v2.deliver_escalation` → `owner_routing.deliver_once_each`: the person's linked Telegram; the box chat if they're the owner; else an in-app notification | `escalation_pusher_v2.py:242-266`; `owner_routing.py:37-45, 128-190` | V |
| Digest | Telegram to `TELEGRAM_ALLOWED_USERS[0]` only (**not owner-routed**) | `digest_cron_v2.py:24-25, 51-58` | V |
| To-do announce | `register_todo` → `announce` + `push_todo(person=…)` | `todo_registration.py:219-226, 242-270` | V |
| Work | `launch_todo_work` → seeded session → review stage → `_propose_reply` | `hermes_cli/todo_work.py:318-377, 388-439` | V |

## 2. Do the pipelines know about profiles?
**No.** Paths are hard-coded: `email_poller.py:25-26`, `email_batcher.py:18-21`, `email_triage_agent.py:22-42`, `batcher.py:30-33`, `triage_agent.py:31-42`, `calendar_*:26-38/31-32`, `triage_handlers.py:244-253`, `hermes_cli/account_owners.py:261-272` (V). They have no profile argument. The `hermes_cli` helpers they call (`load_config`, `get_store('supabase-app','prod')` in `inbound_registration.py:46-52`, `owner_routing.py:53`, `memory_bridge._get_memory_dir` `77-81`, `todo_work.py:424` `get_hermes_home()`) resolve **`$HERMES_HOME` from the process environment**. So the effective profile is whatever `hermes-messaging.env` sets: by the deploy doc, `/opt/data/hermes-home-staging`, the single default profile (I). Triage skills are **not** in any HERMES_HOME skills tree. They live in `/opt/data/skills/<channel>-triage[/custom]` (V).

## 3. Gateway
| Question | Finding | Evidence | V/I |
|---|---|---|---|
| Chokepoint | `_handle_message…` calls `_enrich_channel_source_identity`. `PrincipalResolutionUnavailable` → refusal reply. `None` → drop. Then file/item registration, then session lookup | `gateway/run.py:10440-10465`; background tasks `12979-12991` | V |
| Enrichment | `account_id` comes from the adapter (`config.extra.account_id`). If `internal_user_id` is unset → `bind_channel_principal` through the principal store of the **current profile's** `app_schema("prod")`. If the adapter has a `bridge_name` → `_clamp_whatsapp_bridge_person` | `run.py:3343-3347, 3359-3413`; `gateway/platforms/base.py:5588-5601` | V |
| Clamp | A message from the bridge's own number → the bridge's person (dropped if inactive). Any other sender resolved to a different principal is **unbound** (left anonymous) | `run.py:3415-3440`; `gateway/inbound.py:160-196` | V |
| Unpaired sender | `resolve_principal`: an existing `channel_identities` row wins; else auto-enrol as `member` if pairing-approved; else `None` → the turn keys on raw channel identity | `hermes_cli/access.py:2129-2190`; `inbound.py:125-157` | V |
| Pre-agent gate | Adapter allowlists: the email adapter drops senders not in `EMAIL_ALLOWED_USERS` (default-deny); the WA bridge drops senders not in `WHATSAPP_ALLOWED_USERS`; gateway `_is_user_authorized` | `plugins/platforms/email/adapter.py:750-791`; `bridge.js:106, 426`; `gateway/authz_mixin.py:245` | V (entry points); the full `_is_user_authorized` logic I |
| multiplex | When `gateway.multiplex_profiles` is on, each non-active profile's `config.yaml` platforms start under `_profile_runtime_scope(profile_home)`. Their handler stamps `source.profile`. The same credential claimed by two profiles is refused. Port-binding platforms are refused on secondaries | `run.py:8237-8360` | V |
| Session key | `profile` is folded into the key only when multiplex is on | `run.py:3510-3528` | V |
| Person Telegram bots | One adapter per `telegram-bot` credential (`account_id=tgbot:<id>`), DM from the linked Telegram id only. `internal_user_id` = the credential owner. **No `source.profile` → runs in the active profile** | `gateway/person_telegram_bots.py:50-75, 137-168, 189-207` | V |
| Person WA bridges | One adapter per owned, running, linked bridge (`wabridge:<name>`). The main adapter's port is skipped. **Only the "message yourself" chat** (sender = chat = own number). As the bridge's person. No profile | `gateway/person_whatsapp_bridges.py:1-24, 68-94, 154-190, 238-256` | V |
| Reply adapter | `_source_adapter`: `tgbot:` → that bot, `wabridge:` → that bridge, else the platform adapter | `person_telegram_bots.py:93-100` | V |
| Email adapter | A single mailbox from `EMAIL_ADDRESS`/`EMAIL_IMAP_*` env | `email/adapter.py:437-440, 631` | V |
| `InboundRouter` / `producers.py` | **Only tests import them.** Runtime code imports only `bind_channel_principal` and `clamp_to_bridge_person` from `gateway.inbound` | grep: `run.py:3399, 3427`; tests `tests/gateway/test_inbound_router.py`, `test_producers.py`, … | V |

**So:** messages reach the agent as follows (V for the mechanisms):
- **Install-wide adapters** (main Telegram bot, the main WA bridge if the gateway reads one, the env email inbox): paired → the resolved principal; unpaired but allowed → anonymous, keyed on the channel handle. Always in the active profile, or the adapter's profile under multiplex.
- **Person bots/bridges:** only the owner talking to themselves, as the owner, in the active profile.

## 4. Double processing and third parties
- **WhatsApp:** the bridge queue is drain-on-read. Person-bridge adapters skip the main adapter's port (`person_whatsapp_bridges.py:16-19, 157-165`, V), and the docstring says bridges without a recorded person are left to the batcher. But the batcher's `phone_owner()` also falls back to `bridge-owners.json` (`batcher.py:198-206`). **If a recorded person's bridge is also listed in `whatsapp-messages/config.json` phones, the batcher and the gateway adapter both poll `/messages` and steal each other's messages.** Neither side dedupes or processes the same message twice; each message goes to whichever poller drained it (I; it depends on box config).
- **Email:** the gateway email adapter (`EMAIL_ADDRESS`) and the custom poller are independent IMAP readers. If they point at the same mailbox, a message from an allowlisted sender is processed by **both** (triage + an agent conversation). Nothing in the code prevents it (I; depends on env).
- **Third-party sender:** in the pipeline, every sender is triaged (that is the purpose). In the gateway: email from a non-allowlisted sender is dropped (V). A WA person bridge drops anyone but self (V). A WA install bridge with `ALLOWED_USERS=*` passes anyone to the adapter, and the gateway authz decides (I). An unpaired sender that gets through has no principal, so its session is keyed on the raw handle (V, `inbound.py:142-144`).

## 5. Outbound
| Item | Evidence | V/I |
|---|---|---|
| A proposal is an irreversible FG-10 `approval`, never auto-approved. The account is taken from the arrival's `inbound_items.account_id` | `hermes_cli/todo_outbound.py:11-22, 54-113, 209-244` | V |
| `parse_action` refuses a wrong or unresolvable account. The command carries `--account` | `todo_outbound.py:117-170` | V |
| `execute_proposal`: the approval must be granted and is single-use; the body comes from the approval row → `deliver_message` → `send_message_tool` with `account` | `todo_outbound.py:248-309, 320-369` | V |
| Approve in web → `_settle_todo_proposal` → `execute_proposal`; free text → relaunch with feedback | `hermes_cli/web_server.py:5125-5162` | V |
| `send_message_tool`: an explicit `account` resolves to a WA bridge port (`WHATSAPP_BRIDGES`, then `phones[]`) or an email account from the **custom pipeline `config.json` only**. Unresolved → refused. A bridge owned by another person → refused | `tools/send_message_tool.py:300-342, 345-396, 398-428, 494-507` | V |
| **Gap:** replies to arrivals from personal mailboxes can't resolve an email account. Moot today, because those arrivals are never triaged | `send_message_tool.py:374-396` vs `email_poller.py:521-527` | I |
| Plan `plans/2026-11-12-triage-review-reply-loop.md`: milestones A (`70-84`), B (`86-93`), C (`95-106`), D (`108-114`) all marked **done** in `plans/implementation-status.md:67-82`. Step 14 reuses `/api/triage/status`; step 16 is `custom/tests/test_review_reply_loop.py`, not the planned `test_triage_loop_e2e.py` (missing) | — | V (status table + the files/functions above); UI steps 9/13 not read (I) |

## 6. Seams for a headless triage turn in a profile's agent as user X
| Seam | Signature / behaviour | Evidence | V/I |
|---|---|---|---|
| `agent.seeded_session.spawn_seeded_session(prompt, *, origin, session_id, profile_home=None, runtime, config, session_db, model, enabled_toolsets, disabled_toolsets, max_iterations, reasoning_config, prefill_messages, workdir, load_soul_identity=True, skip_memory=False, …, internal_user_id=None, internal_user_role=None, trusted_local=False)`. Never raises | `profile_home` → `profile_runtime_scope` (HERMES_HOME + secret scope) | `agent/seeded_session.py:69-96, 177-179, 215-220` | V |
| Callers | `todo_work.py:430`, `todos_cmd.py:415`, `projects_run.py:2496`, `cron/scheduler.py:2961` | grep | V |
| `launch_todo_work` | Background thread. `profile_home=get_hermes_home()` (the **process's** profile, not the to-do's), `internal_user_id=principal.user_id`, then finalize → review → propose | `hermes_cli/todo_work.py:388-439, 318-377` | V |
| Prompt cache | Each seeded session is a **fresh** conversation (new `session_id`). The system prompt is built per session from that profile's SOUL/skills/memory. So per-batch triage pays a full prefix every time unless the same session is reused, or the prefix (profile + user skill layers) is byte-stable across sessions for provider-side prefix caching | design rule in `AGENTS.md` ("Per-conversation prompt caching is sacred") | I |
| Per-user layer | None of these seams has a `<home>/users/<user_id>/` skill or memory overlay. `internal_user_id` only scopes principal-aware stores | — | I (no overlay code found) |

## 7. FG-03 checklist vs develop
| Checklist item (FG-03 doc line) | Matches develop? |
|---|---|
| `SessionSource.account_id` + `internal_user_id` + session-key fold-in (`:139`) | **Yes**: stamping at `run.py:3392-3413`. I didn't read the key fold-in in `build_session_key` itself (I) |
| In-process queue + worker pool `InboundRouter` (`:140`) | **Code exists, but only tests use it** (`gateway/inbound.py:226-320`). The live gateway uses its own agent cache by design (doc `:45-58`) |
| Producers stripped to thin normalisers (`:141`) | **No.** `gateway/producers.py` is test-only. `custom/` pipelines still run their own DeepSeek triage (`email_triage_agent.py:104-131`, etc.) |
| Calendar cron producer `run_calendar_sync` (`:142`) | **Not wired.** `producers.py:151` is test-only; calendar runs `custom/calendar/*` |
| Channel prod-only guard (`:143`) | `guard_channel_prod` exists (`inbound.py:199-214`) but is **not called at runtime** (grep). The gateway hard-binds `app_schema("prod")` instead (`run.py:3343-3347`) → effectively met |
| `bind_channel_principal` via C1 (`:144`) | **Yes** (`run.py:3399-3401`) |
| Tests + Shape-2 notes (`:145`) | Tests present (V by file list); I didn't run them |
| Live-gateway wiring (`:146`) | **Yes** for the code |
| System test passed for Telegram; WA/email pending (`:147`) | Can't verify (box) |
| Gateway-migration: enrich at the chokepoint (`:66-74`) | **Yes** (`run.py:10445`) |
| `account_id` from the adapter; "no adapter runs its own DeepSeek triage" (`:75-80`) | Adapters: yes. But the `custom/` triage still does, outside the gateway |
| Egress via the originating account (`:81-84`) | **Yes** for gateway replies (`_source_adapter`). Yes for approvals (`todo_outbound` + `send_message_tool`) |
| Pairing/enrolment (`:85-89`) | **Yes** (`access.py:2129-2190`) |
| Prompt-cache safety (`:90-94`) | Plausible. Enrichment adds key fields only (I) |
| Tests file (`:95-99`) | File exists (V); not run |
| System test on `hermes-systest` (`:100`, unticked) | Still open. Note the doc names the **decommissioned** Alibaba box (`AGENTS.md` banner) |

## Gaps and risks for the target design
1. **There is no routing step.** Today, one source → one triage prompt for the install → owner resolved afterwards. The target needs a per-batch router that picks the owner's user-profiles. A natural insertion point is between the batcher's output and `process_result`, keyed by `owner_user_id`. The owner is **not in the batch JSON**, so the batchers must add it, or the router must ask the registry (`arrival_people`).
2. **Triage isn't an agent.** Moving to "full triage in the profile's agent" means `spawn_seeded_session(profile_home=<profile>, internal_user_id=<owner>)` per chosen user-profile. Cost rises from 1 DeepSeek JSON call to a full agent prefix ×N. Cache reuse needs a stable per-user-profile system prompt, or a long-lived triage session per user-profile (I).
3. **Skill layers.** Today: flat concatenation of `/opt/data/skills/<ch>-triage[/custom]`. Nothing implements built-in → profile → user layering, or a `users/<id>/` dir.
4. **Profiles.** The pipelines, `launch_todo_work` (`get_hermes_home()`), `memory_bridge` and the registry/owner lookups are all bound to one HERMES_HOME and one `supabase-app` prod schema. Per-profile Supabase schemas (FG-27) mean `register_item` / `register_todo` / `arrival_people` must take a profile.
5. **Single-owner sources.** Install-config mailboxes and phones can still have `owner_user_id=None`, which means "install owner" (`email_poller.py:247-261`, `owner_routing.py:70-75`). The target requires exactly one owner per source.
6. **Personal mailboxes aren't triaged, and can't be replied from** (send resolves only custom-config accounts).
7. **Double readers.** A WA bridge listed in both the batcher's config and `bridge-owners.json` can be drained by two readers. An email inbox can be read by both the poller and the gateway adapter.
8. **Fallback semantics.** There is no retry cap today (the file is retried forever). The target's "retry 3× then send to all subscribed" has nowhere to live yet.
9. **Auto-start owner mismatch** (§1.5) and the **digest that goes to the box chat only** (`digest_cron_v2.py:51-58`).
10. **Person bots/bridges have no profile.** Under the target, the owner's own Telegram/WA chat would need a profile choice, or a default user-profile.
11. **The FG-03 doc overstates** producers / router / calendar-sync / prod-guard as done, and points its system test at a decommissioned box.

## Unverifiable here
- The contents of `/opt/data/hermes-messaging.env` (the pipelines' actual `HERMES_HOME`, `TELEGRAM_*`, `DEEPSEEK_API_KEY`), and the email/WA/escalation/digest unit files (they're in the private deploy-state repo).
- Live `config.json` `phones[]`, `accounts[]`, `triage.auto_work`, `skills_dirs`; whether `gateway.multiplex_profiles` is on; whether the gateway's WA/email adapters point at the same bridge or mailbox as the pipelines.
- `todo_store` row scoping (for the auto-start mismatch); full `_is_user_authorized` logic; `build_session_key` internals; agent-home UI pieces of milestones B–D. No tests were run.
