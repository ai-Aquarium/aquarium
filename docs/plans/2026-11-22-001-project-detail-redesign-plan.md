---
title: "plan: Project Detail redesign — Chat + Planning + Execution + Log"
status: draft — Leo answered the open questions on 2026-11-22 (see Decisions) and approved the co-create flow on 2026-11-23; nothing is built until he approves the mockup
date: 2026-11-22
type: plan
origin: Leo, 2026-11-22 (request quoted below)
depends_on:
  - docs/plans/2026-08-12-001-projects-page-plan.md (the "one place" page)
  - docs/plans/2026-08-13-001-todos-and-projects-design-revision.md
  - docs/plans/2026-11-17-001-todos-into-projects-plan.md (a user's to-do is a task = a one-off project)
mockup: docs/design/landing-redesign/mockups/project-detail-redesign.html (standalone, clickable, light + dark, desktop + phone)
---

# Project Detail redesign — Chat + Planning + Execution + Log

Items marked *(suggestion)* are the agent's ideas. Leo has not approved them, and
nothing else in this plan depends on them being accepted as-is.

## Leo's words

> "For the Project Detail page, I want to further improve the User Interface with the following requirements:
>
> Four key sections for the projects interface:
> - Three sections: i) Chat interface (can always select different profiles); ii) Planning section; iii) Execution section; iv) Log section;
> - Chat interface:
>   - The same chat component;
> - Planning section:
>   - Inputs;
>   - Playbook:
>     - Playbook text;
>     - Convert to cards: (kanban or graph presentation);
>     - Versioning;
>   - Outputs;
> - Execution section:
>   - Current run and status of each cards;
>   - Collection of runs;
> - Log section:
>   - Log records of what user executed related to this project;
>
> [...] I want to make the daily 2 major use cases very convenient:
> 1) use chat to initiate a project;
> 2) discuss and talk and plan with the agent under a project (over an over again) to prefect the playbook and steps, also, do a number of runs and analyze the results and improve over time;
>
> I don't necessarily need the task-mode vs the project-mode."

The list says "Three sections" but names four (Chat, Planning, Execution, Log).
This plan treats it as **four sections**: Chat is always on screen, and the other
three are tabs beside it (Decision 1).

## What exists today (develop @ 1dc25964b)

| Area | Today | Where |
|---|---|---|
| Page shell | `MobileShell` (top bar with status chips, Running strip, breadcrumb, Coral launcher bottom-left, Lead chat button bottom-right) | `app/projects/[slug]/page.tsx` |
| Mode switch | `ProjectViewSwitch` + `ModeSwitch` ("Task mode / Project mode"). A one-off project opens as `TaskView`; the choice is saved per device (`saveViewMode`) | `components/projects/task/*` |
| Tabs | Overview (Dashboard) · Work (Board + Iterations) · Files (Outputs + Inputs) · Skills · Setup (Scope + Plan + Settings); `?tab=` deep links, also to old section names | `tabs/groups.ts`, `ProjectTabsNav` |
| Right rail | `JourneyBar` (one next button) + `LiveStatusBar` | `dashboard/`, `live/` |
| Talking to the agent | `AskOrChangeBox` on Overview: a read-only Q&A thread kept in sessionStorage (`POST /{slug}/ask`), plus "Add requirement / change" → `ChangeRequestSheet` → `POST /changes` seeds a playbook draft. **Not** the chat component, no profile picker, no history across devices | `ask/`, `changes/` |
| Chat component | `ChatPane`, `Composer`, `MessageBubble`, `ProfilePicker` (hidden with <2 profiles), `StatusIndicator` ("Agent {profile} is thinking…"), `LeadChatHost` (floating panel bound to one long-running session per user) | `components/chat/*`, `coral/LeadChatHost.tsx` |
| Chat → project | `projects` skill: the agent runs `hermes projects create …` and replies with the short ref; "activating it and starting the first run happen on /projects". Task mode also has `POST /quick-task` | `skills/productivity/projects/SKILL.md`, `projects_api.py` |
| Playbook | `project_playbook` (rev, **body** prose, **steps** JSON with `depends_on`, `checkpoint`, `assignee`, active flag, note, created_by, activated_at). API: `GET/POST /playbook`, `POST /playbook/draft` + poll, `POST /playbook/{rev}/activate`, `DELETE /playbook/{rev}` | `projects_db.py`, `PlanPanel.tsx` |
| Playbook UI | `PlanPanel` (Setup tab): draft with agent, step editor, proposed and earlier revisions. The body text is secondary; there is no rev picker and no diff between any two revs (a step diff exists only inside the change flow: `planDiff.ts`, `PlanDiffView`) | `panels/PlanPanel.tsx`, `changes/` |
| Cards | Steps become kanban cards when a run starts (`project_run_cards.step_key`). `BoardView` shows the live board (4 lanes). There is no "playbook as cards" view and no graph | `board/BoardView.tsx` |
| Runs | `project_runs`: run_no, playbook_rev, status, summary, retro, score_self/score_user (1–5) + note, cost, duration, completion_percent, checkpoint waits. API: `GET /runs`, `GET /runs/{n}`, start/continue/resume/cancel/stop, retro, score, stream, activity. UI: `RunView` page, `RunsPanel` list, `IterationsTab` (runs grouped by requirement version + rev) | `RunView.tsx`, `panels/RunsPanel.tsx`, `iterations/` |
| Run comparison | **Missing**: no side-by-side, no score trend, no per-step outcome across runs | — |
| Log | `recent_events` = kanban `task_events` tail; `GET /changes` (directives + runs). Who-did-what is scattered: `playbook.created_by`, `runs.triggered_by`, `scored_by`, `directives.author_user_id`, `changes.approved.by`. **Missing**: one per-project log of what the user did | `projects_changes_api.py` |
| Inputs / Outputs | `InputsTab` (files, links, notes, memories), `OutputsTab` (declared outputs, deliveries, accept) — both complete | `tabs/`, `inputs/`, `outputs/` |

## The new page (see the mockup)

```
desktop (lg+)                                                       phone
┌ top bar · running strip (unchanged) ────────────────────────────┐ ┌ top bar ───────────┐
│ ‹ Projects / P12 Weekly sales report  active · weekly · v4 ⋯   │ │ ‹ P12 Weekly sales │
├──────────────┬──────────────────────────────────────────────────┤ │ [Chat|Plan|Run|Log]│
│ CHAT         │ [ Planning ] [ Execution ] [ Log ]               │ │ one section at a   │
│ profile ▾    │                                                  │ │ time; Chat is the  │
│ messages     │  Planning: Inputs · Playbook · Outputs           │ │ first tab          │
│ (ChatPane)   │  Execution: current run + runs + compare         │ │                    │
│ composer     │  Log: what people and agents did                 │ │                    │
└──────────────┴──────────────────────────────────────────────────┘ └────────────────────┘
```

### Requirement → screen element → data

| Leo's item | Screen element | Data / API | New? |
|---|---|---|---|
| Chat "can always select different profiles" | Left column, always visible on desktop, first tab on phone; one timeline with profile-labelled turns; `ProfilePicker` sets who answers next | one chat session per profile per project, each linked with `project_links kind='conversation'` (exists); a merged timeline read | **New**: per-profile sessions, merged timeline, catch-up summary (below) |
| "The same chat component" | `ChatPane`/`Composer`/`MessageBubble`/`StatusIndicator`, unchanged, in a narrow variant | `/api/chat/*` | Reuse; layout prop only |
| Planning › Inputs | Inputs card (files, links, memories, "+ Add") | `InputsTab` data | Reuse |
| Playbook › text | Playbook card: the active rev's `body` as readable text, steps under it, "Edit" | `GET /playbook` | Reuse data, new layout |
| Playbook › Versioning | Rev picker (v1…v4, active, proposed), note + author + date, "Compare v3 → v4" diff (text + steps), "Make active" | `revisions[]`, `POST /playbook/{rev}/activate`; diff from `planDiff.ts` + a text diff *(suggestion)* | UI new; no new API |
| Playbook › Convert to cards | "Cards" toggle on the playbook: **Kanban** (one card per step) with a **Lanes by: Latest run \| Planning stage** switch (Decision 3), or **Graph** (DAG from `depends_on`, checkpoints marked) | `steps[]`; latest run's `project_run_cards`; Planning stage = Draft (new or changed vs the active rev) / Ready / Checkpoint (`checkpoint` flag) | UI new; no new API |
| Co-create the playbook in chat (Leo, 2026-11-23) | Chat column + Planning › Playbook: agent asks back, option cards, a live **v6 draft** whose text, steps, cards and graph nodes highlight changes vs the base rev; **Ask about this** on every paragraph, step and card quotes it into the composer; **Save as v6** → proposed → Make active | today `POST/GET /{slug}/playbook/draft` (one-shot job, outside chat); **new** working draft + quote metadata (see "Co-create the playbook") | **New** *(suggestion)* |
| Planning › Outputs | Outputs card (declared outputs, last delivery, accept) | `OutputsTab` data | Reuse |
| Execution › Current run + card status | Current run: rev, progress, per-card status (Done / Running / Needs you / To do), Continue/Stop, opens `RunView` | `GET /runs/{n}`, `useRunLive` | Reuse; compact layout |
| Execution › Collection of runs | Runs table (run, rev, started, duration, status, score, cost) + score trend + "Compare" (pick 2–3 runs: per-step outcome, score, duration, cost, retro lines) | `GET /runs` + `GET /runs/{n}`; *(suggestion)* `GET /{slug}/runs/compare?runs=5,6,7` to avoid N reads | Compare UI new; endpoint optional |
| Log | Filterable list (All / People / Agents, then Playbook / Runs / Tools / Outputs / Inputs): who, what, when, link. People: rev saved/activated, run started/stopped, checkpoint approved, score, output accepted, brief/tool/member edits, chat turns that changed the plan. Agents: scheduled runs, auto re-plans, proposed revs, tool calls in run sessions (Decision 6) | **New** `GET /{slug}/log?actor=all\|people\|agents&kind=…&cursor=` (see "Log data" below) | **New** |
| "I don't necessarily need the task-mode vs the project-mode" | No Task mode anywhere: not on the page, the Projects list or the new-project flow (Decision 4) | `ProjectViewSwitch`, `ProjectsModeView`, `TaskHome`, `TaskModePage`, `ModeSwitch`, `/api/me/project-view-mode` retired | Removal + redirects |

Skills, Scope and Settings leave the tab row (Decision 7): Scope becomes the **Brief** at
the top of Planning › Inputs; Skills and Settings move into the header's ⋯ sheet. Old `?tab=`
links map to the new place (`board`/`iterations` → Execution, `plan` → Planning,
`inputs`/`outputs` → Planning, `settings`/`skills`/`scope` → the sheet / Brief).

### How the project chat works *(suggestion, Leo asked us to propose)*

Leo: "you propose a solution that works the best".

- **One project chat timeline.** Every profile's turns show in order, each labelled with
  its profile ("finance", "research"); Leo's turns show who they went to ("to research").
- **One session per profile per project, behind the scenes.** Profiles are separate
  `HERMES_HOME`s, so each keeps its own session and memories. Switching the picker never
  rebuilds a running session's system prompt, so prompt caching stays safe (AGENTS.md).
- **The picker sets who answers the next message.** A dot marks profiles that already
  have a session for this project; the first message creates one, seeded once with the
  brief, the active playbook and the last run's retro.
- **Catch-up on switch.** When Leo switches to a profile that missed turns, its next
  user turn is prefixed with a short summary of the turns it missed ("Catching up
  finance on 3 messages"). The summary goes in the user message, never the system
  prompt, so roles still alternate strictly (user, assistant, user …).
- **Data.** Each session is linked with `project_links kind='conversation'` and carries
  its profile. The timeline is a merged, time-ordered read of those sessions' messages
  (new read endpoint, e.g. `GET /{slug}/chat/timeline`); the catch-up summary is built
  from the turns after that profile's last turn.
- The agent already has the verbs: `hermes projects playbook save` (lands as a proposed
  rev), `run`, `runs`, `retro`. Chat turns that produce one show an inline card:
  "Proposed v5 · 2 steps changed · Review" which opens Planning › Playbook on the diff.
  Activating and scoring stay human-only, as today.

### Co-create the playbook in chat (Leo, 2026-11-23)

Leo asked: "how do I chat about the playbook?  The key use case is for user to ask questions, ask advices to co-create the project steps (playbook) together with the agent.  Which page shows that user interfaac?"

We proposed the flow below and he replied "Yes, please go ahead". It lives on the Project
Detail page: the chat column plus Planning › Playbook. The flow is ours *(suggestion)*.

| Step | What Leo sees | Mockup |
|---|---|---|
| 1. Ask | "What's missing from this playbook?" or "How should I handle late CRM exports?" (also a quick prompt above the composer) | 2a3 |
| 2. Agent asks back, then options | 1–2 clarifying questions, then 2–3 **option cards** with pros and cons | 2a3, 2a4 |
| 3. Pick or reply | **Pick B**, or answer in his own words | 2a4 → 2a5 |
| 4. Live draft | The agent edits a **v6 draft**; the rev row shows `v6 draft`; changed paragraphs, steps, cards and graph nodes are highlighted vs v5 as they talk | 2a5, 2a7 |
| 5. Ask about this | Every paragraph, step, card and graph node has **Ask about this**; it quotes that part into the composer ("Step 2 · Pull the CRM export") | 2a6 |
| 6. Save | **Save as v6** turns the draft into a proposed rev; then the normal **Make active** (human-only) | 2a8 |

Data / API *(suggestion)*:

- **Today:** `POST /{slug}/playbook/draft` starts a one-shot background job (auxiliary
  task `projects_plan`) that drafts from the brief outside the chat; `GET …/playbook/draft`
  polls it; the result lands as an ordinary inactive revision. State is in-process
  (`_PLAN_DRAFTS`). It cannot follow a conversation.
- **Working draft (new):** one persisted draft per project: `project_playbook_drafts`
  (`project_id`, `base_rev`, `body`, `steps` JSON, `updated_by`, `session_id`,
  `updated_at`).
  - The agent edits it through a CLI verb guided by the projects skill (no new core tool):
    `hermes projects playbook draft show|set|patch-step|discard`.
  - The UI reads `GET /{slug}/playbook/working-draft` (draft, `base_rev`, diff vs base:
    `planDiff.ts` for steps plus a paragraph diff). It refreshes when a chat turn that
    called the verb finishes, using the chat stream's tool events, or by polling.
  - `POST /{slug}/playbook/working-draft/save` creates a proposed rev through the same
    path as `POST /playbook`. `DELETE` discards the draft.
  - Writes carry `base_rev` + `updated_at`, so a manual edit and an agent edit can't
    silently overwrite each other.
  - Activation stays human-only (`POST /playbook/{rev}/activate`).
- **Option cards (new):** the agent replies with a small structured block (e.g. a fenced
  `options` JSON: label, title, pros, cons) that `MessageBubble` renders as cards. Picking
  one sends a normal user message ("Option B: …"), so the transcript stays plain text.
- **Ask about this (UI + message metadata):**
  - The composer holds a quote `{kind: paragraph|step|card, rev, key|index, text}`.
  - On send, the quote becomes a quoted prefix in the user message text
    (`> Step 2 · Pull the CRM export`) and is also kept as message metadata, so the agent
    knows exactly which step is meant.
  - It goes in the user turn, never the system prompt, so prompt caching and role
    alternation are unaffected.

### Log data (Decision 6)

| Actor | Event | Source today | New? |
|---|---|---|---|
| People | rev saved / activated, run started / stopped / continued, checkpoint approved, score, output accepted | `project_playbook.created_by`, `project_runs.triggered_by`, `scored_by`, checkpoint and output rows | Derived, no new table |
| People | brief / input / member / tool edits, chat linked | not recorded | `project_activity` row *(suggestion)* |
| Agents | scheduled run started | `project_runs.trigger='schedule'`, `triggered_by='cron:<job_id>'` | Derived |
| Agents | proposed rev, auto re-plan | `project_playbook.created_by` (profile), re-plan outcomes (`projects_run._record_replan_outcome`, kanban `task_events`) | Derived |
| Agents | tool calls in a run (e.g. `crm.export_opportunities`, `email.send`) | run session (`project_runs.session_id`) messages in that profile's `state.db` | Derived, summarised (name + one-line result), paged |

`GET /{slug}/log` returns `{actor: person|agent, who, kind, text, at, link}` rows newest
first, with `actor` and `kind` filters and a cursor. Tool calls are read lazily per run so
the log stays cheap.

## The two daily use cases

### 1. Start a project from chat (3 actions)

1. In any chat (Home composer, Chats, Lead chat) Leo types "Set up a weekly sales
   report from the CRM export every Monday".
2. The agent (projects skill) asks one question if needed, runs `hermes projects create`
   and drafts v1 of the playbook. Its reply carries a **project card** *(suggestion)*:
   name, ref, "Playbook v1 proposed", buttons **Open project** and **Activate & run 1**.
3. **Open project** lands on Planning with the same conversation continued in the
   left chat column (the creating chat is linked to the project), and v1 shown.

Change vs today: the skill currently stops after `create` and points at /projects; it
would also draft v1 and link the chat *(suggestion)*.

### 2. Iterate: chat → playbook versions → cards → runs → analyse → improve

1. Chat: "Can we add an outlier check after reconciling?" → agent proposes **v5**;
   inline card "Proposed v5 · +1 step" → **Review**.
2. Planning › Playbook shows **v4 → v5** diff (text + steps). Flip **Cards** to Graph to
   check the new step's dependencies. **Make active**.
3. **Run now** (header) → Execution › Current run shows each card's status live; a
   checkpoint card shows **Needs you** with Continue.
4. Execution › Runs: score run 9, tick runs 7, 8 and 9 → **Compare**: per-step
   outcome, duration, cost, score and retro lines side by side, score trend.
5. **Discuss in chat** on the comparison pre-fills the chat: "Run 9 scored 4 vs 3 in
   run 8; step 3 took twice as long. Suggest v6?" — back to step 1.
6. Log shows every action above, by people and agents, with who and when.

Fewest clicks: steps 1→3 are 4 taps (Review, Make active, Run now, Continue).

Before step 1, Leo can **co-create** the next version with the agent: ask, answer its
questions, pick an option, and watch the v6 draft change (mockup steps 2a3–2a8, below).

## Removing Task mode (Decision 4)

Leo: "Should be off completely".

- **Project page.** One layout for every cadence. `ProjectViewSwitch`, `ModeSwitch` and
  `TaskView` are removed from `/projects/[slug]`.
- **Projects list.** `TaskModePage` / `TaskHome` and the `ProjectsModeView` switch are
  removed from `/projects`; the list always shows the project view.
- **New-project flow.** No Task / Project choice. Chat (use case 1) or "New project"
  creates a project; a one-off is just a project with a one-off cadence.
- **Existing task-cadence projects.** No data migration: they are ordinary projects and
  open in the unified page. Their check-in level (`autonomy`) shows in the header; their
  auto-approve runs (`project_runs.auto_approve`) show as normal runs.
- **Old links.** `/projects?view=task`, `/projects/[slug]?view=task` and `?view=project`
  redirect (308) to the same URL without `view`; `?tab=` maps as above.
- **Saved view modes.** `/api/me/project-view-mode` and the per-device preference are no
  longer read; the route answers 410 for one release, then is deleted.
- `POST /quick-task` stays as an API: chat start and "Work on this" on Suggested tasks
  (2026-11-17 plan) use it to create a one-off project.

## Stages (each ships on its own) *(suggestion — order and split)*

| PR | What ships | Risk |
|---|---|---|
| 0 | This plan + mockup (docs only) | — |
| 1 | Layout: chat column + Planning / Execution / Log tabs; Planning reuses Inputs (+ Brief), `PlanPanel`, Outputs; Execution reuses `RunsPanel` + board; Log placeholder from `recent_events`; ⋯ sheet for Skills / Settings; `?tab=` map; Task mode removed from the page, the Projects list and the new-project flow, `?view=` redirects | Old deep links; tests that assert the 5 tabs or Task mode |
| 2 | Project chat: one timeline over per-profile sessions, seeded context, catch-up summary in the next user turn, `ProfilePicker` sets who answers, inline "proposed vN" card | Prompt-cache rules; role alternation; profile isolation |
| 3 | Playbook text + versioning: rev picker, compare any two revs (text + step diff), make active, notes | None new on the API |
| 4 | Convert to cards: Kanban (lanes by latest run or planning stage) / Graph of steps, edit a step from its card | Graph layout on phone (fallback: list) |
| 5 | Execution: compact current run with per-card status; runs table, score trend, compare 2–3 runs (+ optional compare endpoint) | N run reads; card ↔ step mapping for ad-hoc cards |
| 6 | Log: `GET /{slug}/log` for people and agents (runs, re-plans, tool calls) derived from existing records; then `project_activity` for brief / tools / members edits | New table + route-auth tests; tool-call reads per run |
| 7 | Start from chat: skill drafts v1 + links the chat; project card in the chat reply | Skill change is behaviour change for every profile |
| 8 | Co-create: working draft API + `hermes projects playbook draft` CLI verb, live highlights, **Ask about this** quotes, option cards in chat, **Save as vN** | Agent and lead editing the draft at once (`base_rev` + `updated_at` check); option-card format in `MessageBubble` |

## Decisions (Leo, 2026-11-22)

Leo's answers, verbatim: "1. Yes; 2. you propose a solution that works the best; 3. Both; 4. Should be off completely; 5. 1-5; 6. both users and agents; 7. Yes"

| # | Question | Leo | Result |
|---|---|---|---|
| 1 | Four sections, Chat always visible on desktop, Planning / Execution / Log as tabs? | "Yes" | As in the mockup |
| 2 | Chat thread per profile, or one thread? | "you propose a solution that works the best" | One timeline over per-profile sessions with catch-up summaries *(suggestion, Leo asked us to propose)*, see "How the project chat works" |
| 3 | Kanban lanes: latest run or planning stage? | "Both" | "Lanes by: Latest run \| Planning stage (Draft / Ready / Checkpoint)" switch |
| 4 | Task mode on the Projects list too? | "Should be off completely" | Removed from the page, the list and the new-project flow; see "Removing Task mode" |
| 5 | Score 1–5 or 0–10? | "1-5" | Keep the 1–5 human score |
| 6 | Log: people only, or agents too? | "both users and agents" | All / People / Agents filter; agent events in "Log data" |
| 7 | Skills / Scope / Settings into Brief and the ⋯ sheet? | "Yes" | Scope → Brief under Inputs; Skills and Settings → ⋯ sheet |
