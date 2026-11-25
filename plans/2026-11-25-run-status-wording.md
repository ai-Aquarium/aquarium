# Disambiguate run "Done" from project "Done"

## What changed

- `agent-home/src/i18n/messages/{en,zh-Hant}/execution.json` — run-status
  label `status.done` renamed **Done → Finished** (完成 → 已完成). Used only
  by `ExecutionRuns.tsx` (run header pill, runs table, compare CSV).
- `agent-home/src/components/projects/dashboard/standProgress.ts` — when the
  latest run ended but outputs await acceptance, the Iteration step's sub now
  reads **"awaiting review"** instead of "idle" (state stays `done`).

## Why

On the project page, a run could show "Done" while the Where-it-stands
stepper sat at "Review & accept" and the final step read "Done" — three
different "done" concepts (run finished / iteration board cards / project
accepted) shared one word. "Finished" marks the run's lifecycle; "Done" is
now reserved for the project's accepted state, and the Iteration step names
what's actually pending instead of "idle".

## Tests

- `derivations.test.ts` expectation updated (`["done", "awaiting review"]`).
- `vitest run` derivations + execution: 38 green.
