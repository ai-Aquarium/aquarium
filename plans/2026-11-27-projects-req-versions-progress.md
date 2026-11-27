# Project backend gaps B2–B4 — requirement versions, agent progress, compare agent read

Follows `plans/2026-11-27-projects-backend-gaps.md` (decisions locked in #1147).
B1 (iteration batches) shipped as #1148.

## B2 — requirement versions + plan lineage

- `project_requirement_revs` table: snapshot of goal/scope/target_audience +
  links + directives state at save time (decision 1: manual "Save as v" click;
  agent proposals ride the existing proposal flow, never auto-save).
- `projects.requirement_rev_seq` counter → `next_requirement_rev()`.
- `project_playbook.requirement_rev` stamped by `_insert_playbook_rev` /
  `save_playbook_rev` → plan rows can say "from Req vN" (decision: lineage).
- Endpoints: `POST|GET /{slug}/requirements/versions`,
  `GET /{slug}/requirements/versions/{n}`.
- agent-home: API routes `requirements/versions`, `ProjectChatTurn`/playbook
  types carry `requirement_rev` (flows via `SELECT *`); `RequirementsDoc`
  rail built from real `GET requirements/versions` and `save()` POSTs a
  version row first (previously derived `1 + changes.length`); `PlanStep`
  rail rows note "from Req v{requirement_rev}".
- `BriefState` field is `target_audience` (not `audience`).

## B3 — agent_progress Working checklist

- Reuses `project_chat_messages.kind`/`meta` (no new table): rows with
  `kind="agent_progress"` carry `meta.items[] = {task, state, detail}` where
  state ∈ done|working|todo.
- `_member_notes` in `projects_chat_api.py` now passes kind/meta through;
  `POST /{slug}/chat/progress` writes a progress row (for the agent loop to
  emit per-task updates — decision 4: new event type).
- agent-home: `ProjectChatTurn.kind`/`meta`; `ProjectChatPanel` renders the
  latest progress row as an `AgentProgressCard` checklist (✓ done / ◌ working
  / ○ todo) above the co-author strip, matching mockup state 2's Working
  checklist.
- Also fixed a pre-existing `react-hooks/set-state-in-effect` error in the
  follows-you divider (state-in-effect → render-adjust pattern) that was
  failing `npm run lint` on develop.

## B4 — hybrid compare summary

- Deterministic "What changed" bullets (shipped in #1146) stay instant.
- Added "Get the agent's read" link under the bullets → fires the existing
  `onDiscuss` compare draft into the co-author thread, where the agent's
  narrative lands (agent never writes into views it doesn't own).
- Approximation vs the mockup: the narrative appears in the chat panel, not
  auto-streamed inline under the bullets — inline streaming needs a
  session-scoped turn endpoint; noted as follow-up if wanted.

## Verification

- `pytest tests/hermes_cli/test_projects_api*.py` — 85 pass
- `npx tsc --noEmit`, `npx eslint` (touched files), `npx vitest run` (projects
  chat/execution/requirements/plan + hint-ratchet) — green
