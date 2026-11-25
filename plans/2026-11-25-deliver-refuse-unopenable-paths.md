# Refuse deliveries the Outputs page can never open

**Date:** 2026-11-25
**Scope:** `hermes_cli/projects_outputs_api.py`, `hermes_cli/projects_api.py`,
`tests/hermes_cli/test_projects_outputs_api.py`

## Problem

`retain_delivery` (the one gate behind `POST …/outputs/{id}/deliver`) already
refuses a local path that does not exist, but it let two other dead ends
through — seen live on P7 on the HSD box, where all three delivered rows sit
behind a permanently disabled **Open**:

- `link_kind="path"` (off the documented enum `file|url|attachment|session|memory`)
  passed straight through; the artifacts builder has no `path` branch → no
  `href`, `missing` false (the file exists) → disabled Open forever.
- A `workspace`/bare local path that exists but is outside the board's managed
  roots (kanban workspaces root, its `artifacts/` sibling, the attachments
  root, the delivering card's workspace) → `_servable` fails → same dead end.

## Change

`retain_delivery` now treats any local absolute-path ref uniformly:

- inside a card's scratch workspace → keep + record the kept copy
  (`workspace`) — unchanged;
- does not exist → 422 — unchanged;
- exists and `_servable` under the managed roots **plus the delivering
  card's own `workspace_path`** (a `dir` workspace can sit outside the default
  root; resolved from `task_id`) → recorded as `workspace`, whatever kind the
  caller sent;
- exists but not servable → 422 naming the managed-folders reason;
- `link_kind="path"` with any non-local ref → 422 (`path` never resolves to
  an `href` whatever the ref).

`deliver_output` passes `task_id` through. Non-local refs (`url`, `file`,
`session`, `memory`, empty) pass through unchanged.

## Verification

- `tests/hermes_cli/test_projects_outputs_api.py` — 41 pass incl. 4 new cases
  (outside-roots refused for `None`/`path`/`workspace`, `path` refused without
  a file, servable path recorded as `workspace`, card `dir` workspace served).
- `test_projects_api.py` + `test_projects_board_api.py` +
  `test_projects_idempotency.py` — 104 pass.
