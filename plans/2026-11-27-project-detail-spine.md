# Project detail: 4-step spine (Requirements → Plan → Cards → Runs)

PR1 of the approved less-is-more redesign
(`docs/design/projects-detail-redesign/README.md`, design approved by Yan;
Figma `2ulo0wiREINRTTsynkpkgl`).

## What changed

`agent-home/src/components/projects/tabs/sections.ts` — rewritten around the
new model: `PROJECT_STEPS` (`requirements · plan · cards · runs`), `STEP_PARTS`
maps each step to the parts it stacks (requirements: scope+inputs; plan: plan;
cards: board; runs: runs+dashboard+iterations+outputs). `SHEET_PARTS` is now
`log · skills · settings`. `resolveTabParam` keeps every old `?tab=` deep link
working: `planning`→requirements, `execution`→runs, `board`→cards,
`outputs`/`iterations`/`dashboard`→runs (with their part), `log`→sheet.

`agent-home/src/components/projects/tabs/ProjectSpine.tsx` (new) — the spine:
four equal step cards per the Figma spec — step number, name, version/count
pill (`v3`, `6`), one muted line, and an amber warn dot when something in that
step needs the user. On a phone it's a horizontal scroller with Chat appended
as a fifth view. Replaces `ProjectTabsNav` + `ProjectPartsNav` (both deleted).

`agent-home/src/components/projects/ProjectDetailView.tsx` —

- header gains the one-sentence status + **Start run** (primary) and
  **Latest outputs** (secondary) buttons per the mockup; latest-outputs
  jumps to the Runs step's outputs part.
- `spineMeta` feeds each card its pill/sub/warn from real data: requirements
  (input count + "N open questions" warn when clarify is open — replaces the
  old Planning tab badge), plan (`v<rev>` + step count), cards (count +
  needs-you warn), runs (count + `R<n> live` / `avg <score> ★`).
- the panel now stacks only the *active step's* parts (still all mounted,
  no hide/switch — steps are the unit now).
- the ⋯ sheet gains a third tab: Log (skills · settings · log), rendered via
  `ProjectLog`; `?tab=log` opens it there.

i18n — `projects.json` (en + zh-Hant): `steps.aria`, `steps.requirements/plan/
cards/runs` (需求 / 計劃 / 卡片 / 執行), `steps.warn`, `steps.startRun`,
`steps.latestOutputs`.

## Why

The three-section tab model made users hunt for "where the work stands"; the
redesign reframes the page around the project's lifecycle steps. This PR swaps
the navigation skeleton only — every part still renders its existing component,
so PR2+ can rebuild each step's contents independently.

## Decisions

- **Parts stay stacked inside a step** (no sub-tabs): the redesign kills the
  two-tier nav; each step is one page, matching the mockups which have no
  second nav row.
- **Log moves to the sheet** rather than a fifth step — the spine is the
  forward path; log/skills/settings are sideways tools, per the README.
- `data-step`/`data-active-view`/`data-active-tab` attributes preserve the
  testable hooks the old nav exposed; step buttons carry
  `data-appmcp-hint` for the agent layer.
- `ProjectTabsNav`/`ProjectPartsNav` deleted outright (design says they go
  away; nothing else imported them).

## Tests

- Rewritten in `ProjectDetailView.test.tsx`: spine renders 4 steps +
  requirements leads; old `?tab=` values land on the right step + part;
  `?tab=log` opens the sheet on Log.
- `sections.test.ts` — new mapping table.
- `scopeBadge.test.tsx` — badge → spine warn dot + "N open questions" sub.
- `vitest run src/components/projects` — 103 files / 1099 green;
  `tsc --noEmit` + `eslint` clean; app-mcp hint-ratchet green.

## Follow-ups (next PRs in the README order)

- PR2 Runs step per the approved mockup (run list, selected run, inline
  approval, outputs, grade, compare).
- PR3 Start run dialog (approved mockup exists).
- PR4+ Requirements editor / Plan versions / Cards Kanban⇄Graph / agent
  panel — mockups checked in via #1134, awaiting Yan's review.
