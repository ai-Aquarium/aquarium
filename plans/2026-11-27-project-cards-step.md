# PR6 — Cards step (Kanban ⇄ Graph + detail panel)

Redesign step per `docs/design/projects-detail-redesign/` mockups "Cards step
(Kanban)" and "(Graph)". `TAB_COMPONENT.board` → `cards/CardsStep.tsx`;
`tabs/BoardTab.tsx` deleted (`BoardView` stays — still used by `BoardPanel`,
`page.tsx`, `LiveStatusBar`, `CreateSkillSheet`).

## What ships

- **Toolbar** — "Cards" + Kanban⇄Graph toggle + `From Plan v{rev} · status
  from R{latest run}` + **Regenerate** (`POST /playbook/draft`, the existing
  re-draft flow) + **+ Card** (inline form → `POST /cards {title}`).
- **Kanban** — `groupIntoLanes` folds the board's 8 stages into the mockup's
  four columns (Ready = up_next, Running = working, Needs you = waiting,
  Done). Tiles: step number (or ref), title, assignee pill, Auto/Edited
  (`assignment.assigned_by`), amber Approval chip + border when
  `pending_approvals` is non-empty.
- **Graph** — SVG, nodes at (longest-dep-chain level × row-in-level), edges
  from `stepDeps` (`depends_on`/`needs` on the plan steps via
  `current_step_key`). Status dot per node, legend, zoom −/%/+/Fit.
- **Detail panel** (300px, right) — `Card {ref} · Plan v{rev} step {n}`,
  title, Needs-approval / Edited chips, `INSTRUCTIONS` (body), `PROFILE`
  pill + `assignee_reason` (task `assignment` → step fallback), approval
  count, **Open card** (→ `/projects/{slug}/cards/{id}`) + **Ask agent**
  (prefills the discuss sheet).

## Approximations (flagged like the earlier PRs)

- Cards carry no per-card `In:`/`Out:` or input/output-chip fields — tiles
  and the panel omit those lines.
- The mockup's "Ask me before sending" toggle = step `checkpoint`; the panel
  shows the waiting-approval state read-only (edits go through the card page).
- "Regenerate" re-drafts the plan (the server's only regen path); the
  mockup's card-level regen doesn't exist as an endpoint.

## Verify

`tsc` clean; eslint clean; `vitest run src/components/projects` — 106 files
green (one pre-existing flake in `AskOrChangeBox` sessionStorage, passes
isolated); hint-ratchet green. New `CardsStep.interaction.test.tsx` covers
lanes, panel + Ask agent, graph edges + zoom, add-card POST.
