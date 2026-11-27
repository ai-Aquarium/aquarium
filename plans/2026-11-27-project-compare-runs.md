# PR8 — Compare runs view (mockup "Compare runs")

Extends `execution/ComparePanel.tsx` (opened from the run-list tick boxes or
"Compare with R{n}") to the approved mockup:

- **Toolbar** — keeps "Compare runs {a,b}" + Discuss (the agent "what
  changed" question into chat) + close; adds **Swap** (reverses the columns,
  re-keys the fetch) and **Open R{newer}** (`/projects/{slug}/runs/{n}`).
- **Meta rows** — Agent self-score (`score_self`) and Approvals
  (`waiting_on_you` count) join Score/Duration/Cost; cells whose value
  differs from the first column get the accent tint (`data-differs`).
- **"What changed"** — 2–3 plain bullets computed from the two runs' fields
  (plan rev moved, duration Δ%, your-grade Δ); hidden when nothing differs
  or more than two runs are compared.

## Approximations

- Requirements / Iteration batch / Outputs rows omitted — runs carry no
  requirements-rev, batch id or output count field (the same data gaps
  flagged in the design doc).
- "What changed" is client-computed bullets rather than an agent-written
  summary; the Discuss button still hands the comparison to the agent.
- The per-step rows and retro row from the earlier panel stay below the
  meta table.

## Verify

`tsc` + eslint clean; `vitest run src/components/projects` — 107 files /
1108 green; new `ComparePanel.interaction.test.tsx` covers meta rows,
diff tint, Swap and Open R; hint-ratchet baseline lowered (panel gaps 3→2).
