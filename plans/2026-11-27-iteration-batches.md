# B1 — Iteration batches (named run groupings)

First backend-gaps PR (`plans/2026-11-27-projects-backend-gaps.md`, decision 2):
the person creates a named batch ("Christmas Testing") and files runs into it.

## Backend (`hermes_cli/`)

- `project_iteration_batches` table (`id`, `project_id`, `title`,
  `description`, `created_by`, `created_at`, `archived_at`) +
  `project_runs.batch_id` column migration (`_RUN_COLUMN_MIGRATIONS`).
- `projects_db`: `create_iteration_batch`, `get_iteration_batch`,
  `list_iteration_batches` (archived last, `run_count` subquery),
  `update_iteration_batch`, `batches_by_id`.
- `open_project_run` takes `batch_id`; `projects_run.start_run` validates the
  batch belongs to the project (`unknown batch` → 422).
- API: `GET/POST /{slug}/batches`, `PATCH /{slug}/batches/{id}`
  (title/description/archived); `POST /{slug}/runs` accepts `batch_id`;
  `_run_payload` adds `batch`; `_runs_brief` adds `batch_id`+`batch_title`.

## agent-home

- `ProjectIterationBatch` type; `ProjectRunBrief.batch_id/batch_title`;
  `ProjectRun.batch`; client `listProjectBatches`/`createProjectBatch`/
  `updateProjectBatch` + `startProjectRun(batch_id)`.
- Routes `GET|POST /api/projects/{slug}/batches`,
  `PATCH /batches/{batchId}`; runs POST forwards `batch_id`.
- `StartRunSheet`: the mockup's batch select is real — existing batches
  (archived hidden), "+ New batch…" creates then starts, "This run only"
  default; inputs/"new since" meta moved under the select.
- Run rail meta shows `· {batch_title}`; compare table gains an
  "Iteration batch" row.

## Verify

- Direct DB smoke: create/update/archive batch, run carries batch_id,
  run_count joins — all pass.
- `pytest tests/hermes_cli/test_hermes_projects.py` 30 passed;
  `test_projects_api.py` suite run.
- agent-home `tsc` clean.
