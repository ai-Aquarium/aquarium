---
title: "plan: Project Detail redesign — Chat + Planning + Execution + Log"
status: draft — for Leo's review; nothing is built until he approves the mockup
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
three are tabs beside it (open question 1).

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
│ composer     │  Log: what people did                            │ │                    │
└──────────────┴──────────────────────────────────────────────────┘ └────────────────────┘
```

### Requirement → screen element → data

| Leo's item | Screen element | Data / API | New? |
|---|---|---|---|
| Chat "can always select different profiles" | Left column, always visible on desktop, first tab on phone; `ProfilePicker` at its top | chat session linked to the project (`project_links kind='conversation'`, exists) | **New**: a project thread per profile + seeding (below) |
| "The same chat component" | `ChatPane`/`Composer`/`MessageBubble`/`StatusIndicator`, unchanged, in a narrow variant | `/api/chat/*` | Reuse; layout prop only |
| Planning › Inputs | Inputs card (files, links, memories, "+ Add") | `InputsTab` data | Reuse |
| Playbook › text | Playbook card: the active rev's `body` as readable text, steps under it, "Edit" | `GET /playbook` | Reuse data, new layout |
| Playbook › Versioning | Rev picker (v1…v4, active, proposed), note + author + date, "Compare v3 → v4" diff (text + steps), "Make active" | `revisions[]`, `POST /playbook/{rev}/activate`; diff from `planDiff.ts` + a text diff *(suggestion)* | UI new; no new API |
| Playbook › Convert to cards | "Cards" toggle on the playbook: **Kanban** (one card per step, lanes by step stage) or **Graph** (DAG from `depends_on`, checkpoints marked) | `steps[]` | UI new; no new API |
| Planning › Outputs | Outputs card (declared outputs, last delivery, accept) | `OutputsTab` data | Reuse |
| Execution › Current run + card status | Current run: rev, progress, per-card status (Done / Running / Needs you / To do), Continue/Stop, opens `RunView` | `GET /runs/{n}`, `useRunLive` | Reuse; compact layout |
| Execution › Collection of runs | Runs table (run, rev, started, duration, status, score, cost) + score trend + "Compare" (pick 2–3 runs: per-step outcome, score, duration, cost, retro lines) | `GET /runs` + `GET /runs/{n}`; *(suggestion)* `GET /{slug}/runs/compare?runs=5,6,7` to avoid N reads | Compare UI new; endpoint optional |
| Log | Filterable list: who, what, when, link (rev saved/activated, run started/stopped, card approved, score, output accepted, brief/tool/member edits, chat turns that changed the plan) | **New** `GET /{slug}/log`: stage 1 derived from existing columns; stage 2 a `project_activity` row for edits not recorded today *(suggestion)* | **New** |
| "I don't necessarily need the task-mode vs the project-mode" | No mode switch on the page; one-offs open the same four sections | `ProjectViewSwitch` removed from the page | Removal |

Skills, Scope and Settings leave the tab row *(suggestion)*: Scope sits under Inputs
("Brief"), Skills and Settings move into the header's ⋯ menu as a sheet. Old `?tab=`
links map to the new place (`board`/`iterations` → Execution, `plan` → Planning,
`inputs`/`outputs` → Planning, `settings`/`skills`/`scope` → the sheet / Brief).

### How the project chat works *(suggestion)*

- One thread **per project per profile**: profiles are separate `HERMES_HOME`s, so a
  session belongs to one profile. Switching the picker opens that profile's thread for
  this project (created on first message). The picker shows a dot on profiles that
  already have a thread.
- The thread is a normal chat session, linked with `project_links kind='conversation'`,
  so it also shows in Chats and the Lead chat can jump to it.
- Project context (brief, active playbook, last run's retro and score) is sent **once,
  as the seed of the session** — never by rebuilding the system prompt or injecting
  mid-conversation (prompt caching, AGENTS.md). A "Refresh context" action starts a new
  thread when the project has moved on a lot.
- The agent already has the verbs: `hermes projects playbook save` (lands as a proposed
  rev), `run`, `runs`, `retro`. Chat turns that produce one show an inline card:
  "Proposed v5 · 2 steps changed · Review" which opens Planning › Playbook on the diff.
  Activating and scoring stay human-only, as today.

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
6. Log shows every action above with who and when.

Fewest clicks: steps 1→3 are 4 taps (Review, Make active, Run now, Continue).

## Dropping the Task / Project switch

- The project page has one layout for every cadence. `ProjectViewSwitch`, `ModeSwitch`
  and `TaskView` stop being used on `/projects/[slug]`; `?view=task|project` is ignored.
- Existing one-off ("task-mode") projects need no migration: they are ordinary
  projects. Their check-in level (`autonomy`) shows in the header; their auto-approve
  runs (`project_runs.auto_approve`) show as normal runs.
- Saved per-device view modes stay in storage but are no longer read by the page.
- `POST /quick-task` stays: chat start (use case 1) and "Work on this" on Suggested
  tasks (2026-11-17 plan) keep using it.
- The Projects **list** Task mode is out of scope here (open question 4).

## Stages (each ships on its own) *(suggestion — order and split)*

| PR | What ships | Risk |
|---|---|---|
| 0 | This plan + mockup (docs only) | — |
| 1 | Layout: chat column + Planning / Execution / Log tabs; Planning reuses Inputs, `PlanPanel`, Outputs; Execution reuses `RunsPanel` + board; Log placeholder from `recent_events`; `?tab=` map; mode switch removed from the page | Old deep links; tests that assert the 5 tabs |
| 2 | Project chat thread: per-profile session linked to the project, seeded context, `ProfilePicker`, inline "proposed vN" card | Prompt-cache rules; profile isolation |
| 3 | Playbook text + versioning: rev picker, compare any two revs (text + step diff), make active, notes | None new on the API |
| 4 | Convert to cards: Kanban / Graph of steps, edit a step from its card | Graph layout on phone (fallback: list) |
| 5 | Execution: compact current run with per-card status; runs table, score trend, compare 2–3 runs (+ optional compare endpoint) | N run reads; card ↔ step mapping for ad-hoc cards |
| 6 | Log: `GET /{slug}/log` derived from existing columns; then `project_activity` for brief / tools / members edits | New table + route-auth tests |
| 7 | Start from chat: skill drafts v1 + links the chat; project card in the chat reply | Skill change is behaviour change for every profile |

## Open questions

1. **Four sections?** You wrote "Three sections" and listed four. The mockup keeps Chat
   always visible on desktop and puts Planning / Execution / Log as tabs. OK?
2. **Chat thread per profile?** Picking another profile opens that profile's own
   thread for this project (profiles don't share memory). Or do you want one thread
   where the picker only changes who answers the next message?
3. **Kanban lanes for playbook cards:** by run state of the latest run (To do /
   Running / Needs you / Done), as in the mockup, or by planning stage (Draft / Ready /
   Checkpoint)?
4. **Task mode on the Projects list:** remove it too, or only from the project page?
5. **Scores:** keep the 1–5 human score (today's data), or change to 0–10 as in the Canva
   concept?
6. **Log scope:** only what people did, or also what the agent did on its own
   (scheduled runs, auto re-plans)? The mockup has a filter for both.
7. **Skills / Scope / Settings:** OK to move them out of the tab row into Brief and a
   ⋯ sheet?
