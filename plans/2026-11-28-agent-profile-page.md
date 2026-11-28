# Agent Profile page — full-page detail, status, connectors, history & skills growth

**Status:** design — mockup v2 under review (no implementation yet)
**Date:** 2026-11-28
**Branch target:** `feat/profile-page` off `develop` (includes the list redesign #1164)

## Mockups

- **Figma** (editable layers): https://www.figma.com/design/v0JLkZzwlOXU3eVr86iIsI
  Four frames, one per history tab — `Agent Profile — Chats`, `— Projects`,
  `— Scheduled jobs`, `— Skill uses`.
- **Canva** (AI interpretation, v2 brief): https://canva.link/mubrphnm7he7thf
  (v1: https://canva.link/8m1vdgnc6o42fhf)

v2 revisions per review feedback:

- **Same visual language as the grid card** — creature avatar, name +
  `creature · model` line, status pill, uppercase `GOAL` label, activity
  line with accent dot + `<n> need you` warning pill, the same 4 metric
  cells (Tokens·30d + sparkline, Skills used `x/installed`, Projects,
  Chats·30d "across n channels"), the used/installed progress bar, and the
  `Top:` skill chips.
- **Skills allow a long list** — "On this agent" and "Could learn" are
  full-height scrollable lists (not the 4-panel compact row); "Most used"
  stays a top-N.
- **"Who can use it"** section was added back (enrolled people + roles).

## Goal

Replace the `ProfileEditor` side-drawer with a full page at `/profiles/[name]`
that lets a **non-technical owner** understand what an agent-profile is doing
and improve its effectiveness. Three pillars, in priority order:

1. **Status & history** — what it is doing now and what it has done (stats
   first, details after).
2. **Skills growth** — the key feature: what it is good at, what it could
   learn, and how to teach it more (including self-learning from its own
   history, and evolving its goal + soul over time).
3. **Reach** — which user-owned connectors (email, WhatsApp, Telegram, MCP
   servers, gateway/triage) this profile can use, with assignment toggles.

## Non-goals / explicitly excluded

Per request, none of these appear on the page:

- `alias_name`, wrapper dir, `hermes-<name>` CLI shortcut
- `distribution_name/version/source`, `distribution.yaml`
- `.env` / `has_env` credential file
- full `config.yaml` editing (model timeouts, advanced settings)

Also out of scope for v1: per-profile cron editing, memory browser,
per-profile MCP install (MCP stays configured under Tools & Integrations).

## Mental model (the words the page uses)

Hermes internals get friendly labels; technical names stay only where users
already know them (SOUL.md, model names):

| Internal term | On the page |
|---|---|
| profile | "agent" (page title: the profile name) |
| description (`profile.yaml`) | "Goal" |
| SOUL.md | "Personality & standing instructions" |
| skill | "Skill" / "what it's good at" |
| source route (`source_routes`) | "Ways to reach it" / "Connected inboxes & channels" |
| gateway | "message handling" (running/paused) |
| needs_you | "Waiting for you" |
| session | "chat" |
| kanban task / project | "work item" / "project" |
| cron job | "scheduled job" |
| `description_auto` | "suggested by AI — review" |

## Data inventory → where it shows

Already available (no new endpoints):

- `GET /api/profiles` → `ProfileInfo`: name, is_default, description,
  creature, model, provider, skill_count, gateway_running, description_auto
- `GET /api/profiles/stats?days=30` → `ProfileStats`: tokens, cost_usd,
  tokens_by_day[7], chats, messages, chat_sources, last_active_at,
  skills_used, top_skills[{name,uses}], projects_done, projects_running,
  tasks_running, current_task{kind,title,started_at}, needs_you, channels[]
- `GET /api/profiles/{name}/soul`, `PUT soul`, `PUT description`,
  `PUT model`, `PUT creature`, `PATCH` (rename), `DELETE`,
  `POST describe-auto` — all exist
- `GET /api/profiles/sessions?profile=<name>&limit=…` — per-profile chat
  history straight from `state.db` (no backend spawn)
- `GET /api/skills/library` → `SkillLibraryEntry.used_by[{profile,enabled}]`
  — gives both "enabled here" and "available but not configured"
- `GET /api/skills/usage?profile=<name>` + `/detail` — per-skill use rollups
  and the chat/card/project each use came from (admin-gated already)
- `GET /api/sources` → each `Source.routes[{profile_slug, enabled}]` —
  inverted to get "connectors that reach this profile";
  `PUT /api/sources/{sourceId}/routes/{profile}` toggles one (owner of the
  source only, and only to a profile they're active in)
- `GET /api/tools/mcp/servers?profile=<name>` — install-wide MCP servers,
  profile-scoped reads already supported by the Python side
- `GET /api/triage/status?profile=<name>` — used by `ProfileSkillsPanel`
- Projects/tasks per profile — kanban `assignee = profile name`;
  `GET /api/projects` rows + per-profile counts already in stats
- Skills Lab — `POST /api/skills/create/{start,message,save}` (learn a new
  skill from a project's history) and `POST /api/skills/improve/{start,message}`
  (improve an existing skill from its usage + version history); drafts land
  disabled until a version is activated via `skills_versions_api`
- `profiles/[name]/triage` — existing page, linked not duplicated
- `open-terminal`, `setup-command` — existing endpoints for the overflow menu

Gaps (checked against `web_server.py` 2026-11-28 — smaller than first thought):

- ~~**Cron jobs per profile**~~ — **already exists**: `GET
  /api/cron/jobs?profile=<name>` returns the profile's jobs via
  `_list_cron_jobs(profile)` (schedule, prompt, enabled, last/next run);
  `GET /api/cron/jobs/{id}/runs?profile=` gives run history as sessions.
  The BFF only needs a thin proxy route. Read-only = simply don't render
  the existing mutate verbs.
- **Needs-you items for one profile** — `GET /api/needs-you` exists and
  tags entries with `context.profile` (`ny.tag_profile`); either filter
  items client-side or add a `?profile=` filter server-side (few lines).
- **"Suggested skills" relevance scoring** — the only genuinely new
  endpoint: `GET /api/profiles/{name}/skill-suggestions` (Python side,
  following the `profile_describer.py` LLM pattern) that scores every
  library skill not enabled on this profile, 1–10 against the profile's
  goal + SOUL.md — LLM-assisted, cached per (profile, skill, soul-hash)
  so the page stays fast.

## Page structure

Route: `agent-home/src/app/profiles/[name]/page.tsx` (owner/admin gated like
the list page), `loading.tsx` beside it. The `[name]/triage` sub-page stays.

```
┌────────────────────────────────────────────────────────┐
│ HEADER: creature (click to change) · name · status     │
│ pill · goal (editable) · ⋮ menu (rename, duplicate,    │
│ open terminal, delete)                                 │
├────────────────────────────────────────────────────────┤
│ 1. "How it's doing" — stat strip                       │
│    tokens 30d + 7-day sparkline · cost · chats ·       │
│    projects · skills used · "waiting for you" ·        │
│    last active                                         │
├────────────────────────────────────────────────────────┤
│ 2. "Right now" — current task banner + waiting-for-you │
│    list (deep-links into the item)                     │
├────────────────────────────────────────────────────────┤
│ 3. "What it's good at" — SKILLS (the centerpiece)      │
│    a. most used (top_skills + usage detail links)      │
│    b. all skills on this agent — LONG scrollable list  │
│       (enable/disable toggle per row, search filter)   │
│    c. "could learn" — LONG scrollable list, library    │
│       skills scored 1–10 vs goal+soul; one-click add   │
│    d. "teach it something new" — Skills Lab entries:   │
│       learn from a project, improve a used skill,      │
│       discover/browse the library                      │
├────────────────────────────────────────────────────────┤
│ 4. "Ways to reach it" — connectors                     │
│    channels (email / WhatsApp / Telegram sources       │
│    routed here, each with on/off switch + owner note)  │
│    · MCP servers available to it · gateway/triage      │
│    status · setup hints when nothing is connected      │
├────────────────────────────────────────────────────────┤
│ 5. "What it's been doing" — history                    │
│    tabs: chats · projects · scheduled jobs · uses of   │
│    skills (ledger)                                     │
├────────────────────────────────────────────────────────┤
│ 6. "Personality & direction"                           │
│    goal editor (+ auto-write) · SOUL.md editor ·       │
│    model picker · "learned recently" hints (things it  │
│    improved from history)                              │
├────────────────────────────────────────────────────────┤
│ 7. "Who can use it" — enrolled people & roles          │
│    (owner/admin view; collapsible)                     │
├────────────────────────────────────────────────────────┤
│ DANGER ZONE — rename / delete (confirm by typing name) │
└────────────────────────────────────────────────────────┘
```

Sections are cards with plain-language headings + one-line explanations; the
triage page, skills pages, sources page and project pages are deep-linked, not
re-implemented.

### Section notes

**Header** — `CreatureIcon` + name + `Pill` status (reuses `profileStatus`
from `profile-cards.ts`) + goal text with inline edit (same save path as the
drawer). ⋮ menu holds rename/duplicate/open-terminal/delete.

**1. Stats strip** — same data your cards already render (`ProfileStats`,
`?days=30`), just enlarged: the sparkline, cost, and a "waiting for you" pill
that jumps to section 2. Read-only.

**2. Right now** — `current_task` banner ("Working on <title> since <time>")
plus the needs-you items. Empty state: "Idle — nothing running."

**3. Skills** — the growth loop in four panels:
- *Most used*: `top_skills` with counts; each row links to
  `/api/skills/usage/detail` view filtered to this profile (the detail rows
  name the chat/card/project — instant "show me an example").
- *On this agent*: `SkillLibrary.used_by` filtered to this profile; toggles
  call `POST /api/skills/library/{add,remove}` — reuse `ProfileSkillsPanel`
  logic rather than the drawer copy. Rendered as a **scrollable long list**
  (all installed skills, with a search filter) — not a top-N — since a
  profile can carry 90+ skills.
- *Could learn*: library entries not enabled on this profile, each scored
  **1–10 for relevance** — the BFF scores each candidate's skill description
  against this profile's **goal + SOUL.md** (LLM-assisted, cached;
  10 = most relevant). Sorted descending; each row shows the score, name,
  description, and an **Add** button. Also a **scrollable long list**
  (threshold ~5 keeps it bounded but it can still run long).
- *Teach it*: three entries — "Improve a skill it already uses" (skills
  improve chat seeded with its usage record), "Learn from a finished project"
  (skills create chat seeded with that project's cards), "Browse the skill
  library" (link). Lab drafts save disabled and activate via Versions — the
  page labels this clearly ("new skills start off until you turn them on").

**4. Ways to reach it** — renders `Source` objects whose routes include this
profile, grouped by channel kind (mailbox / WhatsApp / Telegram), each with
the route toggle (`PUT /api/sources/{id}/routes/{profile}`). Sources the user
owns but hasn't routed here appear in a collapsed "not connected" group so
discovery is one click. MCP servers shown read-only with a link to Tools &
Integrations. Gateway status + a link to the profile's triage page. Only
rows the principal owns are toggleable; others show "managed by <owner>".

**5. History** — tabbed:
- *Chats*: `GET /api/profiles/sessions?profile=<name>` — title, when,
  message count, source; row opens the chat.
- *Projects*: projects where `assignee`/runs name the profile — status,
  result, link.
- *Scheduled jobs*: new `GET /api/profiles/{name}/cron` — schedule, what it
  does, last run/result.
- *Skill uses*: usage ledger detail rows — "used <skill> in <chat/project>".

**6. Personality & direction** — goal textarea (auto-write button),
SOUL.md editor (mono font, same save semantics: applies to new chats),
model select (same `model-choices` helper). A small "suggested update" hint
when `description_auto` is true ("AI wrote this — review it").

**7. Who can use it** — enrolled people + roles via the existing
`comms/people` endpoints; collapsed by default; box owner only.

## UX rules

- One page = one agent; every control says what changes and when it takes
  effect ("new chats use this").
- Save is per-field (same pattern as the drawer — PUT on blur/button), no
  page-level form submit.
- Everything destructive stays behind the type-the-name confirm.
- Empty states teach ("No chats yet — start one from Home").
- Mobile-first: sections stack; stat strip scrolls horizontally.

## Implementation shape

- `app/profiles/[name]/page.tsx` — server component: `getPrincipal` +
  `canAdminister`, resolve profile, fetch `ProfileInfo` + stats (SSR like
  the list page), render `ProfilePage` client component.
- `components/profiles/ProfilePage.tsx` + small per-section components
  (`ProfileStatsStrip`, `ProfileActivity`, `ProfileSkillsGrowth`,
  `ProfileConnectors`, `ProfileHistory`, `ProfileIdentity`). Reuse
  `ProfileSkillsPanel`, `model-choices`, `CreatureIcon`, `Pill`, `Sheet`
  button classes, `ActionButton`, `InlineAlert`, `InfoTip`.
- List card `onClick` navigates to `/profiles/<name>` instead of opening the
  drawer; `initialOpen` deep-link param is replaced by the route. The
  `ProfileEditor` drawer component is retired (or kept behind a flag for one
  release — decide in review).
- BFF: thin proxy routes only — `cron` (→ `/api/cron/jobs?profile=`),
  `skill-suggestions` (→ new Python route), `needs-you` (→ `/api/needs-you`,
  filtered). Everything else reuses the existing `named/[name]/*` routes
  (soul, description, model, creature, describe-auto, PATCH rename, DELETE)
  plus `/api/profiles/sessions`, `/api/skills/library`, `/api/skills/usage`,
  `/api/sources`, `/api/tools/mcp/servers`, `/api/triage/status`.
- Python: `GET /api/profiles/{name}/skill-suggestions` — new route in
  `web_server.py` next to the profile routes; scoring helper beside
  `profile_describer.py`; optional `?profile=` filter on `/api/needs-you`.
- i18n: `profiles.json` namespace additions in en + zh-Hant, matching the
  existing key style.
- Route roles: `route-roles.json` entries for the new BFF paths (admin).

## Decisions (resolved in review)

1. **Drawer replaced entirely** — the page is the single place to edit;
   `ProfileEditor` is retired and its save logic moves into the page.
2. **"Could learn" = goal/soul relevance score** — each candidate skill's
   description is matched against the profile's goal + SOUL.md and scored
   1–10 (10 = most relevant), LLM-assisted and cached. Not a popularity sort.
3. **Cron is read-only in v1** — list what each job does, its schedule, last
   run + result; no edit/pause/delete controls yet.
4. **Non-owned connectors hidden** — only sources the caller owns render;
   other people's sources are never listed.
5. **Card-consistent chrome** — the detail page reuses the grid card's
   structure verbatim: avatar + `creature · model` line, `GOAL` uppercase
   label, activity line + need-you pill, the same `Metric` cells + sparkline,
   used/installed progress bar + `Top:` chips — so the page reads as the
   card "zoomed in".

## PR breakdown (3 PRs, sequential)

**PR 1 — Python backend (small).** `GET /api/profiles/{name}/skill-suggestions`:
read the profile's `profile.yaml` goal + `SOUL.md`, load the skill library,
LLM-score each not-enabled skill 1–10, cache results keyed by
(profile, skill, goal+soul hash); return `{skill, score, reason}[]` sorted
desc. Add `?profile=` to `/api/needs-you` for the waiting-for-you list.
pytest coverage with a mocked LLM call. ~1 file + tests.

**PR 2 — agent-home page (the bulk).** `app/profiles/[name]/page.tsx` +
`loading.tsx`; `ProfilePage` + section components (header mirror of the card,
stats strip, right-now, skills growth with long scrollable lists, connectors,
history tabs, personality, who-can-use-it, danger zone). BFF thin routes for
cron/skill-suggestions/needs-you. Card `onClick` → `router.push` to the page
(drawer code left dormant). i18n en + zh-Hant, `route-roles.json` entries,
vitest coverage. If PR 1 hasn't merged, "Could learn" ships with a plain
"available but not enabled" list (no scores) and the scored list slots in
without UI changes.

**PR 3 — retire `ProfileEditor` (tiny).** Delete the drawer component, its
deep-link param, and dead code paths; redirect any external deep-links to
`/profiles/[name]`. Separated so PR 2 stays reviewable and rollback of the
page doesn't resurrect edit flows.

## Test plan

- pytest: `test_fleet`-style file for the new cron endpoint (fake cron store)
  + existing profile API suites still green.
- vitest: `ProfilePage` SSR render, `ProfileConnectors` toggle calls,
  `ProfileSkillsGrowth` candidate ranking, sections render with empty stats.
- Route-role mapping test picks up the new BFF paths automatically.
- Manual on Leo's box: open `/profiles/default` and `/profiles/storyteller-author`
  — verify stats, toggles, lab entries, and the triage link end to end.

## Implementation status

- 2026-11-28: design doc + Figma/Canva mockups v1; review feedback applied
  (card-consistent style, long skill lists, 4 history-tab page frames).
- 2026-11-28: mockups approved. **PR 1** (`feat/profile-skill-suggestions`,
  #1168) — `GET /api/profiles/{name}/skill-suggestions` (LLM-scored 1–10 vs
  goal + SOUL.md, cached by context hash) + `?profile=` filter on
  `/api/needs-you`, with pytest coverage.
- 2026-11-28: **PR 2** (`feat/profile-page`) — `/profiles/[name]` page:
  card-mirror header (creature/goal/model/status editable in place), stats
  strip, right-now needs-you, skills growth (most-used, on-this-agent long
  list, scored could-learn, teach-it), connectors (source-route toggles +
  MCP + gateway/triage), tabbed history (chats/projects/cron/skill-uses),
  personality (SOUL.md + model), who-can-use-it, danger zone. Card click
  navigates to the page; the drawer render is removed from ProfilesView.
  New BFF: `GET /api/profiles/named/[name]/skill-suggestions`. i18n stays
  as page-level literals, matching the profiles grid.
- 2026-11-28: **PR 1 merged (#1168)**; PR 2 up as #1170. **PR 3**
  (`chore/retire-profile-editor`, stacked on `feat/profile-page`) —
  deletes `ProfileEditor`, `ProfileSkillsPanel` (+ test), `TriageCard`
  (+ test + fixtures), all drawer-only; the `?open=` redirect to the page
  stays for old deep-links. Hint-ratchet baseline regenerated.
