# PR7 — Agent co-author panel (mockup "Agent co-author panel", approved #1142)

Re-skins the docked `ProjectChatPanel` to the approved 5-state mockup on top of
the existing group-chat machinery (timeline proposals, seed notes, persisted
dock state, unread badge).

## What ships (per approved decisions, #1142)

- **Context strip** — "Working on {Step · vN/Rn}" + "Sees N items" at the
  pane top; per-step label, sees-list and suggestions computed in
  `ProjectDetailView` (one thread per project+person — the same pane
  carries across steps).
- **Empty state** — "Co-write the {step}" + step-matched suggestion chips
  (prefill the composer) + "What I can see" list.
- **Follows you** — switching step inserts a "You moved to {label}"
  divider note until the next send.
- **Proposal card** (mockup state 3) — `v{base} → v{rev}` pill, per-changed-
  step struck-old/green-new lines via `planDiff` (threaded `playbook`, no
  extra fetch), "N steps unchanged"; `Save as v{rev}` (existing activate),
  `Edit first` (→ `?tab=plan&rev=N`, opens the plan step where Edit is one
  click), `Discard` (`DELETE /playbook/{rev}` — agent never saves itself).
- **Collapsed rail** — amber badge counts unresolved proposals + board
  pending approvals (mockup "counts what needs you"); folded into the
  existing unread badge (amber when needs-you > 0).

## Header fix from #1144 decision 3

`Start run` renders as the primary button only on the Runs step; on the
other three steps it drops to the secondary style (the step's own action —
e.g. Requirements' Save — stays the primary one).

## Approximations

- Working-state checklist: the mockup's per-todo agent progress ("Read
  Requirements v6 ✓ / Rewriting steps 3,4 ◌") has no timeline feed — the
  existing busy indicator + Stop stays.
- "Edit first" navigates to the plan step's editor rather than opening an
  unsaved applied draft (no server-side staged edit exists).
- Attach/@-mention menu and inline run actions are unchanged (existing
  composer attachments and card links stay).

## Verify

`tsc` + eslint clean; `vitest run src/components/projects` — 106 files /
1107 tests green; `ProposedPlaybookCard` tests updated (Save as v5 /
Edit first / Discard) + new DELETE assertion.
