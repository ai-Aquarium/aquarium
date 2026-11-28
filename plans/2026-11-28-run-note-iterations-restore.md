# 2026-11-28 — Run note + restore orphaned Iterations/Standing-instructions

## Problem

1. The "less is more" step navigation (Requirements → Plan → Cards →
   Runs) left `iterations` out of `STEP_PARTS` — `IterationsTab` became
   unreachable, orphaning **Standing instructions** (the directive add
   field), the iteration history cards, `RequirementHistory`, and the
   "Start a new iteration with changes" button.
2. No per-run steering existed: `POST /runs` took only
   `trigger`/`playbook_rev`/`batch_id`, so a before/after project had no
   way to say "this run uses *this* file" without a persistent directive.

## Change

- **A (restore):** `STEP_PARTS.runs` gains `"iterations"` — the whole
  `IterationsTab` renders at the bottom of the Runs step under an
  ITERATIONS heading. `?tab=iterations` now maps to
  `{view:"runs", part:"iterations"}` so old deep links scroll to it.
- **B (run note):** Start-run dialog gains a "Note for this run"
  textarea → `POST /runs {note}` → `start_run(note=)` → `project_runs.note`
  (new column via `_RUN_COLUMN_MIGRATIONS`) → `compile_guidance` emits a
  `### This run only` section between Standing instructions and the
  retro (never truncated by the guidance cap). The note rides `dict(run)`
  to the run detail header (muted chip under the meta line). One-off —
  stored on the run, never a directive, never leaks to the next run.

## Verified

- pytest `test_projects_run.py` green incl. `test_run_note_lands_in_guidance_and_never_leaks`
  (note in guidance + on the row; absent from run 2; no directive leaked).
- tsc clean; touched-area vitest green (105); full suite run below.
