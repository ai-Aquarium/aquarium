# FG-03 P0 — Task A: data & storage scoping audit

Repo `ai-Aquarium/aquarium`, branch `develop` @ `ea324d093`. All citations are `path:line` on that commit. **V** = VERIFIED (read in code), **I** = INFERRED.

**Words used:** *box-wide* = one copy per machine. *per-profile* = one copy per HERMES_HOME (`profiles/<name>/`) or per profile app schema. *per-user* = keyed by `owner_user_id` / GoTrue subject.

**Production layout:** prod `HERMES_HOME` is `/opt/data/hermes-home-staging` (`docs/deployment/README.md:70`), but the custom triage pipelines hard-code `/opt/data/...`. That puts them **outside every profile home**, so they are effectively box-wide.

---

## Summary table

| # | Item | Stored today | Scope today | Target needs |
|---|---|---|---|---|
| 1 | GoTrue accounts | one `auth.users` per box | box-wide | unchanged |
| 1 | `principals` / `channel_identities` / `principal_aliases` | profile app schema (`app_prod` / `app_prod_<slug>`) | per-profile, keyed by user_id | already the enrolment table; `channel_identities` PK must not double as the source→owner router |
| 2 | Password mailboxes | `credentials` table, profile schema | per-profile × per-user (`owner_user_id`) | must become a **source** owned by one user, outside a single profile schema |
| 2 | Poller account list `EMAIL_CONFIG_PATH` | `/opt/data/email-messages/config.json` | box-wide | replace with a source registry |
| 2 | Google-connected accounts | `credentials` (provider `google`), profile schema | per-profile × per-user | same as mailboxes |
| 2 | `account_owners` | profile schema table, owner-only RLS | per-profile; key (surface, account_key) | becomes source.owner (one owner, box-level) |
| 3 | WA bridges `bridge-owners.json` | `<HERMES_HOME>/whatsapp/` | per-profile file, per-bridge owner | move to box-level source registry |
| 3 | WA phones list | `/opt/data/whatsapp-messages/config.json` | box-wide | replace with a source registry |
| 4 | Per-person TG bot | `credentials` kind `telegram-bot`, profile schema | per-profile × per-user (one per user) | source, routed to several user-profiles |
| 4 | Box bot `TELEGRAM_BOT_TOKEN` | profile `.env` / env | per-profile (per gateway profile) | stays box/profile operator bot |
| 5 | `inbound_items` | profile schema | per-profile, unique (owner, surface, account, external_id) | a write per chosen user-profile, or a box-level item plus per-profile fan-out |
| 6 | Triage skills | `/opt/data/skills/*-triage[/custom]`, `.versions/*.jsonl` | box-wide | built-in → profile → `users/<uid>/` layering |
| 6 | Profile skills | `$HERMES_HOME/skills`, `skills/.versions`, `config.yaml skills.disabled` | per-profile | add a user layer |
| 7 | MEMORY.md (shared) | `$HERMES_HOME/memories/MEMORY.md` | per-profile | unchanged |
| 7 | Per-user memory | `$HERMES_HOME/memories/users/<uid>/MEMORY.md` | **per-user within a profile (exists)** | reuse or move under `users/<uid>/` |
| 7 | USER.md | `<root>/persons/<uid>/USER.md` | per-user, box-wide | unchanged |
| 7 | INBOX_FACTS.md | `$HERMES_HOME/memories/INBOX_FACTS.md` (from pipeline env) | per-profile, owner-role-only | must become per-user |
| 7 | Supabase memories | `memories` table, profile schema, owner/visibility | per-profile × per-user | ok |
| 8 | messaging/email/calendar SQLite | `/opt/data/{whatsapp-messages,email-messages,calendar}/*.db` | box-wide, no owner column (I) | needs a source or user key per row |
| 8 | To-dos | `tasks` table, profile schema | per-profile × per-user | ok |
| 8 | Notifications / Needs You | `notifications` (profile schema, I) + `$HERMES_HOME/needs_you/pushed-<user>.json` | per-profile × per-user | ok |
| 9 | Per-user sub-folders | `memories/users/<uid>/`, `<root>/persons/<uid>/`, `<root>/auth/user_prefs/<hash>.json`, `credentials/<uid>/` (file backend) | — | `<profile>/users/<uid>/` does not collide with any of these; see §9 |

---

## 1. Users, accounts and profile enrolment

- **V** `principals.user_id` *is* the GoTrue subject. `channel_identities` maps `(platform, channel_user_id)` onto it (`hermes_cli/access.py:10-12`).
- **V** DDL (`hermes_cli/access.py:546-588`):
  - `principals(user_id PK, display, role, created_at, active)`
  - single-owner partial unique index (`:561-562`)
  - `channel_identities PK(platform, channel_user_id) → principals` (`:565-571`)
  - `principal_aliases(alias_subject PK → user_id)` for pre-GoTrue principals (`:575-585`)
- **V** It is per-profile. `initialize_access` creates the tables "in the connection's schema"; `search_path` selects the profile's schema (`hermes_cli/access.py:591-608`).
  - Schema name is `app_prod` for the default profile, else `app_prod_<slug>` (`hermes_cli/datastore.py:10-13, 219-238`).
  - The slug comes from the active `HERMES_HOME`, including the per-turn override (`hermes_cli/datastore.py:195-216`).
- **V** There is one GoTrue per box. Its keys are box-global secrets (`agent/secret_scope.py:144-148`; FG-28 D2 at `docs/design/master-plan/feature-groups/FG-28-multi-profile-administration.md:43`).
- **V** One GoTrue user is in a profile when that profile's `principals` has a row with the same `user_id` (`FG-28…md:78-79, 145-158`).
  - Suspension is the per-profile `active` flag, not a GoTrue ban (`hermes_cli/access.py:551-556, 2146-2150`; FG-26 rationale `FG-26…md:501`).
- **V** `resolve_principal` resolves an existing `channel_identities` row first. Otherwise it auto-enrols a pairing-approved sender as `member` (`hermes_cli/access.py:2128-2199`).
- **V** Pairing approvals live in `HERMES_HOME/platforms/pairing/*.json`, i.e. per-profile (`gateway/pairing.py:52, 204-207`).
- **Who reads/writes:** profile owner/admin through the users console (FG-26). Owner-transfer needs a prod store (`hermes_cli/access.py:1354-1361`).
- **Change for target:**
  - `channel_identities` PK `(platform, channel_user_id)` allows **one principal per handle per profile**. That is fine, because the same GoTrue subject is enrolled per profile.
  - A *source* (a mailbox or bot the user receives on) is a different concept from a channel identity (who the sender is). Do not overload `channel_identities` for source ownership.
  - The router needs a **box-level list of "user X's subscribed profiles"**. Today that list only exists by scanning every profile schema (FG-28 `console_scope.enrolments`, `FG-28…md:55`; **I** that it is not yet wired everywhere, `FG-28…md:20`).

## 2. Email mailboxes, poller config, Google accounts, account owners

**Password mailboxes**
- **V** Stored as credential kind `email-imap` / provider `imap`, name = the address, visibility `private:<user>` (`hermes_cli/email_mailboxes.py:3-6, 40-43`).
- **V** The credential store is Supabase table `credentials`, `UNIQUE(owner_user_id, provider, name)` (`hermes_cli/credential_store.py:529-545`).
  - It uses `get_store("supabase-app","prod")`, the **active profile's schema** (`hermes_cli/credential_store.py:1110-1124`).
  - File fallback: `$HERMES_HOME/credentials/<user>/<provider>/<name>.json` (`hermes_cli/credential_store.py:13, 562-584`).
- **V** Runtime state: `$HERMES_HOME/email/mailbox_{tests,poll}.json`, keyed `"<owner_user_id>/<address>"` (`hermes_cli/email_mailboxes.py:14-16, 87-98`).
- **V** UI lists only the caller's own mailboxes (`:268-273`). `all_mailboxes()` returns every person's mailbox for the poller (`:365-370`).

**Poller account list**
- **V** `EMAIL_CONFIG_PATH`, default `/opt/data/email-messages/config.json` (`custom/email/email_poller.py:26`; `hermes_cli/email_accounts_api.py:29`).
  - The API first reads `config.yaml email_poller.config_path` (`hermes_cli/email_accounts_api.py:42-51`).
  - Box-wide JSON; each entry can carry `owner_user_id`.

**Owner resolution per arrival**
- **V** Order: Settings `account_owners` choice → config entry `owner_user_id` → whoever saved the credential → install owner (`custom/email/email_poller.py:248-261`; `hermes_cli/account_owners.py:1-12`).

**Google accounts**
- **V** Credential provider `google`, service flags (`hermes_cli/account_owners.py:285-290`; `custom/email/email_poller.py:285-288`).
- Same table and same profile schema as password mailboxes.

**`account_owners` table**
- **V** `PK(surface, account_key)`, `owner_user_id → principals` (`hermes_cli/account_owners.py:53-63`).
- **V** RLS: owner role only, restrictive policy (`:65-82`).
- **V** Stored in the profile prod schema (`:446-451`). Pollers cache it for 60 s (`:86, 474-494`).

**Change for target:**
- Today a mailbox is one row in one profile schema, and the poller's profile is whatever schema its process resolves.
- **I:** the pipelines run under `/opt/data/hermes-messaging.env` (`deploy/hermes-calendar-triage.service:17`), whose `HERMES_HOME` I could not see. In practice they read the **default profile** schema only.
- A source owned by John and routed to John@CFO and John@CMO needs a **box-level source registry** (source id, owner subject, credential ref, subscribed profiles), plus a credential that is readable without being inside one profile schema.
- `account_owners` (an owner-picks-person map) contradicts "a source has exactly one owner user who set it up". It should collapse into `source.owner`.

## 3. WhatsApp bridges and the phones list

**Bridge owners**
- **V** `<HERMES_HOME>/whatsapp/bridge-owners.json`, shape `{"<name>": {user_id, port, added_at}}` (`hermes_cli/wa_bridge_owners.py:11-12, 26`).
- **V** It is per-profile: `whatsapp_dir()` uses the request's profile override, else the process `HERMES_HOME` (`:36-46`).
- **V** Session dir: `<HERMES_HOME>/whatsapp/session-<name>` (`:49-50`).
- **V** The systemd units are box-wide: `/etc/systemd/system/hermes-wa-bridge-<name>.service`, env in `/etc/aquarium/wa-bridge-<name>.env` (`:28-30`; `deploy/hermes-wa-bridge@.service:19`).
- **V** A bridge with no record belongs to the install owner (`:8-9, 70-73`).

**Gateway reading of person bridges**
- **V** The gateway runs one adapter per owned and linked bridge. It accepts only the owner's "message yourself" chat and stamps `internal_user_id` = owner (`gateway/person_whatsapp_bridges.py:1-23`).

**Triage phones list**
- **V** `/opt/data/whatsapp-messages/config.json` `phones[]` with `id`, `number`, `owner_user_id`, `bridge_port` (`hermes_cli/account_owners.py:263, 351-370`).
- **V** The path is hard-coded in `custom/whatsapp/triage_agent.py:38`, `batcher.py:30`, `mcp_server.py:20`, `digest_cron.py:26`, `escalation_pusher.py:24`; `tools/send_message_tool.py:360`; `hermes_cli/triage_status.py:37`. Box-wide.
- **V** Phone owner order: Settings choice → `phone.owner_user_id` → bridge recorder → install owner (`custom/whatsapp/batcher.py:187-196, 493-497`).

**Change for target:**
- Today two registries exist, a per-profile bridge-owners file and a box-wide phones list, with a 3–4-step owner fallback chain.
- Target: a bridge/number is **one** source with **one** owner at box level. The profile-scoped `bridge-owners.json` would make the same bridge invisible to the other profiles it routes to.

## 4. Telegram

**Per-person bot**
- **V** One credential per user: `telegram/bot`, kind `telegram-bot`, private to the owner (`hermes_cli/telegram_bot_api.py:3-10, 30-32`).
- **V** Stored in the profile schema via the credential store (`:78-80, 88-92`).
- **V** The gateway loads every `telegram-bot` entry (`gateway/person_telegram_bots.py:116-118`). It runs each linked bot, answers only the linked Telegram id, and acts as the owner. Replies go out on `account_id = "tgbot:<bot id>"` (`:1-16, 50-53`).
- **V** A bot claimed by two owners, or the install bot itself, is never run (`:50-53`).
- **V** Change marker: `$HERMES_HOME/telegram_bots.changed` (`hermes_cli/telegram_bot_api.py:60-64`; `gateway/person_telegram_bots.py:224-227`).
- **V** The loop starts in the gateway (`gateway/run.py:7031`).
- **I:** it runs only in the gateway's own (default) profile, because the credential store resolves the active profile schema. Multiplexed secondary profiles get `_profile_adapters` (`gateway/run.py:2638-2643`), but I did not find a person-bot loop per secondary profile.

**Box bot**
- **V** `TELEGRAM_BOT_TOKEN` is read via `_credential_env` (`gateway/config.py:1227, 1293`). It is a per-profile secret under the multiplexer secret scope (`gateway/run.py:1373-1395`).
- **V** The person bot code leaves it "untouched" (`gateway/person_telegram_bots.py:6`).

**Escalation delivery**
- **V** To the person's `telegram:` channel, else (owner only) the first `TELEGRAM_ALLOWED_USERS` chat, else in-app (`custom/shared/owner_routing.py:1-45`).

**Change for target:**
- "Exactly one bot per user" (fixed name `bot`) blocks a user owning two bot sources.
- The bot lives in one profile schema, so routing to John@CMO would need the CMO profile to see it.
- Outbound must keep `tgbot:<id>` as the leaving account. That part already matches "replies leave via the receiving account".

## 5. Inbound registry

- **V** Table `inbound_items` with `owner_user_id`, `visibility`, `surface`, `account_id`, `external_id`, `importance`, … (`hermes_cli/inbound_registry.py:98-139`).
- **V** Unique identity `(owner_user_id, surface, account_id, external_id)`; upsert (`:20-24, 144-145`).
- **V** Uses `get_store("supabase-app", mode)`, the active profile's schema (`:555-569`).
- **V** The custom pipeline writes through `register_arrival` as the resolved owner, else the install owner (`custom/shared/inbound_registration.py:236-275`).
- **V** It is a projection; the raw payload stays in SQLite (`hermes_cli/inbound_registry.py:11-15`).
- **Change for target:**
  - One arrival routed to N user-profiles → N rows in N schemas, all with the same `(owner, surface, account, external)`. That is legal, because the unique key is per schema.
  - Each chosen profile needs its own write path, which the pipelines do not have today (they write only to their own process's schema, **I**).
  - Alternative: a box-level arrival table plus per-profile triage results. Also needs the routing decision (0..N chosen and why) stored somewhere; no such column exists.

## 6. Triage skills and profile skills

**Triage skills**
- **V** Default dirs (`hermes_cli/triage_status.py:42-46`):
  - email reads `/opt/data/skills/whatsapp-triage` **and** `/opt/data/skills/email-triage`
  - whatsapp reads `/opt/data/skills/whatsapp-triage`
  - calendar reads `/opt/data/skills/calendar-triage`
- **V** Each dir is also scanned under the `custom/` subdir (`:47, 116-143`). This is overridable through `triage.skills_dirs/skills_subdirs` in each pipeline's box-wide config.json.
- **V** The same defaults are hard-coded in `custom/whatsapp/triage_agent.py:41, 70-80` and `custom/email/email_triage_agent.py:35-36, 83`.
- **V** Sources ship in `custom/skills/{email,whatsapp,calendar}-triage` (`hermes_cli/triage_status.py:49-53`).
- **V** Versions: `<dir>/.versions/<file>.jsonl`, append-only with author (`hermes_cli/triage_status.py:527, 563-564, 609-620`).
- **V** On prod these dirs are **outside** `HERMES_HOME` (`docs/deployment/README.md:70`), so they are box-wide.
- **Who writes:** `can_edit` (`hermes_cli/triage_status.py:505`; I did not read its body, **I**: owner/admin).

**Profile skills**
- **V** `$HERMES_HOME/skills` (`hermes_constants.py:966-968`).
- **V** Version store: `$HERMES_HOME/skills/.versions/<skill>/…`, admin-only (`tools/skill_versions.py:7-8, 63`; `hermes_cli/skills_versions_api.py:1-6`).
- **V** `config.yaml skills.disabled` is profile-global (`agent/skill_utils.py:394`; `hermes_cli/skills_config.py:36-49`).
- **V** Cross-profile sharing exists only through `skill_promotion` (two-stage approval) (`hermes_cli/skill_promotion.py:1-30`).

**Change for target:**
- Triage skills must move from box-wide `/opt/data/skills` to three layers: built-ins (repo `custom/skills`) → `<profile>/skills/*-triage` → `<profile>/users/<uid>/skills/*-triage`.
- `triage_file` only addresses files listed by `skill_sources` (`hermes_cli/triage_status.py:544-560`); it must learn the layers.
- The `.versions` jsonl needs a per-layer location.
- No per-user `skills.disabled` exists.

## 7. Memory

- **V** FG-24 already splits memory per user within a profile (`tools/memory_tool.py:11-20, 71-91`):
  - `memories/MEMORY.md`: profile-shared, owner/admin writes
  - `memories/users/<uid>/MEMORY.md`: "participation (person × profile)"
  - `<root>/persons/<uid>/USER.md`: the person across all profiles (`:94-109`)
- **V** User ids are validated, and the path is confined under `users/` (`tools/memory_tool.py:112-123`).
- **V** `--clone-all` excludes `memories/users/` and `persons/` (`hermes_cli/profiles.py:118-136, 159`).
- **INBOX_FACTS:**
  - **V** File: `$HERMES_HOME/memories/INBOX_FACTS.md`, written by `custom/shared/memory_bridge.py`. The memory dir comes from the pipeline's `HERMES_HOME` env, else `~/.hermes` (`custom/shared/memory_bridge.py:4-10, 77-81`).
  - **V** It reaches the system prompt only for role `owner`, or an unscoped CLI (`tools/inbox_memory.py:40-44, 73-78`).
  - So it is **per-profile and owner-only, not per-user**. A member's own mailbox facts never reach that member.
- **V** Supabase memory tier: `memories` table with `owner_user_id` + `visibility`, in the profile schema (`plugins/memory/supabase_pgvector/store.py:9-10, 143-163`).
- **Change for target:**
  - INBOX_FACTS must become `users/<uid>/…`, written for each chosen user-profile. Today the bridge writes exactly one file in the pipeline's home.
  - Decide whether `memories/users/<uid>/` stays or moves under `users/<uid>/memories/`; see §9.

## 8. Channel SQLite DBs, to-dos, notifications

**Channel DBs**
- **V** Defaults (overridable by env, all under `/opt/data`, box-wide):
  - `MESSAGING_DB_PATH=/opt/data/whatsapp-messages/messaging_data.db`
  - `EMAIL_DB_PATH=/opt/data/email-messages/email_data.db`
  - `CALENDAR_DB_PATH=/opt/data/calendar/calendar_data.db`
  - (`custom/migrations/split_channel_dbs.py:27-35`; `custom/email/email_poller.py:25`; `custom/whatsapp/triage_agent.py:39`)
- **V** Table split by domain (`split_channel_dbs.py:7-16`).
- **I:** no `owner_user_id` column in the channel tables. The migrations (`custom/migrations/create_email_tables.py:12-66`, `create_calendar_tables.py:29-81`, `migrate_phase1.py:53-167`) never add one. `email_messages` has `account_id` (`create_email_tables.py:23`), and WA uses `source_phone`.
- **V** The email triage agent also opens the messaging DB (`custom/email/email_triage_agent.py:33`).

**To-dos**
- **V** FG-06 `tasks` rows with `owner_user_id`/`visibility`; dedupe `(owner_user_id, dedupe_key)` (`hermes_cli/todo_store.py:1-25, 162-176`).
- **V** Profile schema (`:381-393`).

**Notifications**
- **V** Table `notifications` (`hermes_cli/human_comms.py:127, 291`).
- **I:** stored in the profile schema; I did not find its `get_store` line.

**Needs You**
- **V** Aggregates notifications, project waits and in-memory approvals (`hermes_cli/needs_you.py:1-21`).
- **V** Push ledger: `$HERMES_HOME/needs_you/pushed-<user>.json` (`:678-687`).
- **V** In-app fallback for escalations: `custom/shared/owner_routing.py:107`.

**Change for target:**
- The box-wide SQLite DBs hold raw messages and triage state for **all** users and profiles with no profile column. Per-user-profile triage results (importance, drafts, to-dos) need a key such as `(user_id, profile)`, or a move into each profile schema.
- To-dos and notifications are already per-profile × per-user, so each chosen profile writes its own rows.

## 9. Existing per-user sub-folders, and conflicts with `<profile>/users/<user_id>/`

| Existing path | Scope | Source |
|---|---|---|
| `$HERMES_HOME/memories/users/<uid>/MEMORY.md` | user × profile | `tools/memory_tool.py:16, 91` |
| `<root>/persons/<uid>/USER.md` | user, box | `tools/memory_tool.py:107-109` |
| `<root>/auth/user_prefs/<sha256[:40]>.json` | user, box root | `hermes_cli/user_prefs.py:37-38, 57-60` |
| `$HERMES_HOME/credentials/<uid>/<provider>/<name>.json` | user × profile (file backend) | `hermes_cli/credential_store.py:13, 562-584` |
| `$HERMES_HOME/needs_you/pushed-<user>.json` | user × profile | `hermes_cli/needs_you.py:681` |

- **V** Nothing already uses `<HERMES_HOME>/users/`. The only `"users"` path segment in Python is `memories/users` (grep of `hermes_cli tools agent gateway custom`).
- **Conflicts and risks:**
  - **(a) Two homes for per-user memory.** `memories/users/<uid>/` and the new `users/<uid>/` would both hold per-user memory. Choose one, and migrate or alias.
  - **(b) Clone and export.** `--clone-all` excludes only `memories/users` and `persons` (`hermes_cli/profiles.py:127, 136`). A new `users/` dir **would be copied by `--clone-all`** unless added to the exclude list, leaking one user's skills or memory into a clone. Export ignore (`_default_export_ignore`, same file) needs the same check.
  - **(c) Removing a user.** `person_memory_files_on_box` enumerates only `memories/users/<uid>` and `persons/<uid>` for removal (`tools/memory_tool.py:219-245`). The new folder would be missed on user deletion.
  - **(d) Skill discovery.** Skill discovery scans `$HERMES_HOME/skills`. `users/` is outside it, so there is no accidental skill load, but the loader needs an explicit user layer.
  - **(e) Profile name.** A profile named `users` is fine: profiles live under `<root>/profiles/`.

---

## Gaps and risks for the target design

1. **There is no box-level source registry.** Source config is spread over a box-wide JSON (email, WA phones), per-profile `credentials` rows (mailboxes, Google, TG bot), a per-profile `bridge-owners.json`, and per-profile `account_owners`. A source routed to several profiles needs one owner record outside any single profile schema.
2. **Credentials are profile-schema-bound.** CMO's agent cannot read a mailbox saved in CFO's (or the default) schema. The FG-27 ownership guard refuses foreign schemas by design (`FG-26…md:502`).
3. **The pipelines are default-profile only (I).** They hard-code `/opt/data/...` and resolve one schema. Fanning out to chosen profiles means running triage in each profile's runtime scope (`agent/profile_runtime.profile_runtime_scope`, `gateway/run.py:1371-1395`), which these standalone services do not use today.
4. **Owner fallback chains** (Settings → config → saver → install owner) contradict "exactly one owner". A source with no owner silently goes to the install owner.
5. **"One TG bot per user"** (fixed credential name `bot`) blocks multiple bot sources per user.
6. **Raw channel SQLite has no owner or profile key**, so per-user-profile triage state cannot coexist in it.
7. **INBOX_FACTS is owner-role-only per profile**, not per user, so members' facts are lost.
8. **Triage skills are box-wide**, outside `HERMES_HOME`, and email reads WhatsApp skills too. They need three-layer resolution and per-layer `.versions`.
9. **The routing call has no home:** no store records the subscribed user-profiles per (owner, source), nor the per-batch routing decision.
10. **`<profile>/users/<uid>/` must be added** to the clone/export excludes and the user-deletion sweep, and reconciled with `memories/users/<uid>/`.
11. **Enumerating a user's profiles** needs a scan across all schemas (FG-28 `enrolments`). The router would do this per batch unless subscriptions are cached at box level.

## Ambiguous or not verified

- The pipelines' actual `HERMES_HOME` and DSN: the contents of `/opt/data/hermes-messaging.env` are not in the repo. The unit files for the email and WA poller/batcher/triage services are not in `deploy/`; only the calendar triage unit was read.
- Whether `/opt/data/skills` on prod is a symlink into a profile home.
- Which schema `NotificationStore` uses: assumed profile schema, line not found.
- Whether secondary multiplexed profiles run person TG bots or person WA bridges: only the main loop at `gateway/run.py:7031` was seen.
- Whether the channel SQLite tables gained owner columns elsewhere at runtime: grep of `custom/` found none.
- The `can_edit` role rule for triage files: `hermes_cli/triage_status.py:505`, body not read.
