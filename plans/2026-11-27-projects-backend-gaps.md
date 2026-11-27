# Projects backend gaps — versions, batches, agent progress

Design decisions from Yan (2026-11-27) closing the three data gaps flagged in
`docs/design/projects-detail-redesign/` §8, plus the agent summary choice.

## Approved decisions

1. **Requirements versions are explicit.** The person saves a version with a
   button ("Save as vN+1"); the agent may *detect* a change and propose
   saving a version (proposal card — the agent never saves itself, #1142).
2. **Iteration batches are named entities.** The person creates a batch
   (title + description, e.g. "Christmas Testing") and puts runs into it.
   Not a derived snapshot.
3. **"What changed" in compare = hybrid.** Deterministic bullets render
   instantly (already shipped in PR8); an agent turn streams the narrative
   summary beneath them (small context: both runs' stats + retro + plan
   diff); falls back to bullets only if the agent is unavailable.
4. **New timeline event type for agent task progress** — feeds the Working
   checklist in the co-author panel ("✓ Read Requirements v6 / ◌ Rewriting
   steps 3,4").

## Schema (additive, `hermes_cli/projects_db.py`)

- `requirement_revisions`: `project_id`, `rev`, `goal`, `description`,
  `audience`, `links_snapshot` (json), `directives_snapshot` (json),
  `created_by`, `created_at`, `note`. Counter on project:
  `projects.requirement_rev`.
- `iteration_batches`: `id`, `project_id`, `title`, `description`,
  `created_at`, `archived`. `project_runs.batch_id` (nullable FK).
- `playbook_revisions.requirement_rev` — lineage ("from Requirements v5"),
  stamped at draft time.
- Timeline: new event kind (e.g. `agent_progress`) carrying
  `{task, state: done|working|todo, detail?}` items for the checklist.

## Endpoints (`hermes_cli/projects_api.py` + agent-home routes)

- `GET/POST /projects/{slug}/requirements/versions`,
  `GET /requirements/versions/{rev}` (+ activate/restore?)
- `GET/POST /projects/{slug}/batches`,
  `PATCH /batches/{id}` (title/desc/archive)
- `POST /projects/{slug}/runs` accepts `batch_id`
- `POST /projects/{slug}/compare/summary` (or chat-scoped): agent turn that
  writes the what-changed narrative; agent-home streams it under the
  deterministic bullets.
- Timeline emits `agent_progress` events during agent work; chat timeline
  read includes them.

## agent-home follow-ups

- RequirementsDoc: real `vN` (replaces rail approximation), Save → POST
  version; agent "detected a change — save as v{n}?" proposal card.
- PlanStep rail: "from Requirements v{n}" lineage (replaces timestamp
  approximation).
- StartRunSheet: real batch picker — existing batches + "New batch"
  (title/desc fields); batch label in run rail meta.
- CardsStep/ComparePanel: batch row in compare table.
- Co-author panel: Working checklist from `agent_progress` events.

## PR order

1. B1 — batches entity + `batch_id` on runs (smallest, unblocks Start-run)
2. B2 — requirement_revisions + counter + lineage stamp on playbook revs
3. B3 — agent_progress timeline events + Working checklist
4. B4 — compare agent summary (hybrid) + batch/requirements rows in compare
