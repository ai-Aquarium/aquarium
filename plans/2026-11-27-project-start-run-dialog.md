# Plan — PR3: Start run dialog (projects detail "less is more" redesign)

Design: `docs/design/projects-detail-redesign/` — frame "Start run dialog"
(Figma `2ulo0wiREINRTTsynkpkgl`, node `1:277`; approved by Yan). Third PR in
the README's build order after the spine (#1135) and Runs step (#1136).

## What

Replace the header "Start run" button's navigate-to-Runs behavior with the
mockup dialog:

- **Plan version** — `<select>` of `playbook.revisions` (newest first),
  `v{N} · latest` on the active rev, muted line `N steps`. The run-start API
  already accepts `playbook_rev`, so the choice is honored server-side.
- **Iteration batch** — a row naming "Current inputs" with
  `N inputs · K new since R{m}` (links with `added_at` after the last run's
  `started_at`).
- **This batch uses** — chips for every input link (label or ref tail,
  30-char capped), across files/links/memories.
- **Estimate** — `About {lo}–{hi}` (±20% around the mean duration of prior
  runs) · `about $X.XX` (mean cost, shown only when the record endpoint
  returns `cost`) · `{n} will ask for your approval` (steps with
  `checkpoint: true` on the chosen rev). "First run — no estimate yet."
  when there is no history.
- **Footer** — Cancel / Start run → `POST /api/projects/{slug}/runs`
  `{playbook_rev}` via `useProjectAction`; on success `onStarted` selects
  the Runs step and the dialog closes.

## Approximations (no backend field exists)

- **No batch entity**: the mockup's "Nov week 4" select has nothing to
  select — rendered as a single info row over the current inputs. Same gap
  the design doc already flags.
- **Cost**: `ProjectRunBrief` carries no `cost`; the sheet fetches
  `GET /runs` and reads `cost` defensively — the cost segment hides when
  the record doesn't include it. Duration comes from `duration_seconds`
  (briefs) or `ended_at - started_at`.
- **Approvals counted from `checkpoint` steps** — the closest stored
  signal to "this step will pause for you".

## Files

- `agent-home/src/components/projects/StartRunSheet.tsx` — the dialog.
- `agent-home/src/components/projects/StartRunSheet.interaction.test.tsx` —
  renders fields, posts `playbook_rev`, first-run estimate.
- `agent-home/src/components/projects/ProjectDetailView.tsx` — button now
  opens the sheet (`setStartRunOpen`), sheet mounted beside the others.
- `agent-home/src/i18n/messages/{en,zh-Hant}/projects.json` — `startRun.*`.

## Verify

- `npx tsc --noEmit` — clean.
- `eslint` touched files — clean.
- `vitest run src/components/projects` — 104 files / 1100 tests green.
- `hint-ratchet` — green (all new buttons carry `data-appmcp-hint`).
