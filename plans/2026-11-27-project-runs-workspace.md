# Project detail: Runs step workspace (redesign PR2)

PR2 of the approved less-is-more redesign
(`docs/design/projects-detail-redesign/README.md`; Runs-step mockup approved
by Yan 2026-11-27, Figma frame `1:2`).

## What changed

`agent-home/src/components/projects/execution/RunsWorkspace.tsx` (new,
replaces `ExecutionRuns.tsx`) — the Runs step as a master-detail workspace:

- **Run list rail** (264 px on desktop, collapses to a capped-height block
  on phone): one row per run — tick box, `R<n>` + status pill (dot +
  label), `Plan v{rev} · trigger · duration`, and `★ score` for graded
  runs; `Compare` header link (enabled at 2+ ticks) and the hint line from
  the mockup. A footer link keeps the full run page one tap away.
- **Run detail**: `R<n>` + status pill + meta (`Plan v{rev} · started
  {time} · ${cost} so far`), live via the existing `useRunLive` stream.
  Actions per state: waiting → Continue (primary) + Pause + Stop (with
  confirm); running → Pause + Stop. "Pause" is the `cancel` endpoint —
  same semantic as the old Cancel ("stop promoting new work; a running
  card finishes"), relabelled to the mockup's verb.
- **Progress**: "{done} of {total} steps" + bar + a rough `about X min
  left` derived from the finished cards' average pace (only once a card
  has finished; the run read has no ETA field).
- **Step rows**: state icon (done ✓ / running / needs ! / todo ○) +
  title + `assignee · duration` — the assignee comes from a board join by
  `task_id` (run cards carry no profile field).
- **Inline approval**: under every `needs` card, the amber "Approval
  needed" box — plain-language reason (from `waiting_on_you` or the
  card's error), the approval's detail (`ApprovalDetail` — tool args,
  command, or the proposed outbound message), Approve / Reject (or the
  outbound send/deny/revise trio) posting to the existing
  `cards/{taskId}/approvals` endpoint, plus Open card and Ask agent
  (pre-fills the project chat composer).
- **Outputs so far**: tiles of this run's artifacts
  (`useProjectArtifacts` filtered by `run_no`) — ext badge, name, output
  or kind; open via `href` or the shared `useFileRefOpener` for storage
  refs; `Download all` downloads every `downloadHref`-able artifact.
- **Grade this run**: 5 star buttons (filled = saved score), Add note
  (saves with the score — the endpoint requires a score, so Save note is
  gated until a star is picked), agent self-score when present, and
  `Compare with R<previous>` opening the compare panel.
- **ComparePanel** moved verbatim to `execution/ComparePanel.tsx`; tick
  2–3 rows or use the grade's compare button. (The dedicated Compare
  *screen* is still PR8 per the README.)

Supporting files: `execution/runData.ts` (fetch helpers + action paths),
`execution/runUi.tsx` (shared tones/icons/labels). `ExecutionRuns.tsx`
deleted — the table/trend/inline-current layout is superseded; `runStats.ts`
helpers (`cardState`, `mergeRunHistory`, `compareRows`, `toggleCompare`…)
are reused unchanged.

`tabs/sections.ts` — `STEP_PARTS.runs` is now `["runs", "outputs"]` —
Dashboard and Iterations fold into the workspace per README §7 (their
components stay in the tree for PR4+'s versions/history surfaces);
`?tab=dashboard`/`?tab=iterations` now land on the Runs step itself.
`?tab=outputs` still lands on Runs and scrolls to the outputs registry —
the deliver/accept surface is untouched.

i18n — `workspace.*` block added to `execution.json` (en + zh-Hant):
rail, actions (Continue/Pause/Stop — 暫停/停止), approval, outputs,
grade strings. Existing `status.*`/`state.*`/`compare.*` keys reused.

## Why

The mockup's answer to "how is the work going" is one screen: pick a run,
see its steps, answer its ask, grade it — instead of four stacked views
(Current run card + runs table + Dashboard + Iterations + Outputs).

## Decisions

- **Pause = `cancel`.** The mockup says Pause/Stop; the domain's real
  verbs are cancel (no new work promoted, running card finishes) and
  stop (terminate). "Cancel" understates nothing but reads like the run
  is dead; "Pause" with the honest tooltip matches intent better.
- **Batch label omitted.** Runs record `playbook_rev` but no iteration-
  batch id (README's flagged data gap); the meta line shows plan rev +
  trigger + started + cost instead of inventing one.
- **ETA is a client estimate** (avg finished-card pace × remaining),
  labelled "about" — no server field exists.
- **Board join for assignee + approvals.** Run cards lack profile and
  approval records; the board read fills `assignee` and
  `pending_approvals` on blocked cards, so no extra fetch is needed.
- **Grade gating**: stars are live only for finished runs (the mockup's
  "opens when R7 finishes"); note rides along the score endpoint since
  it can't save alone.

## Tests

- New `RunsWorkspace.interaction.test.tsx` (7 cases): rail + live-run
  default selection, row-swap, inline approval (reason + detail +
  approve POST), grade-star save + compare-with-previous, tick-2 compare,
  per-run output tiles, Pause → `cancel` POST.
- Updated `sections.test.ts` + `ProjectDetailView.test.tsx` for the
  dashboard/iterations fold (they now assert the step, not a section id).
- `vitest run src/components/projects src/lib/app-mcp` — 108 files /
  1149 tests green; `tsc --noEmit` + `eslint` clean; hint-ratchet
  baseline regen'd (all new elements carry `data-appmcp-hint`).

## Follow-ups

- PR3: Start run dialog (approved mockup) — plan version + batch + estimate.
- PR8: the dedicated Compare screen (mockup pending Yan's review); the
  panel reused here stays the interim answer.
- Batch entity + server ETA + per-card profile on the run read would
  remove this PR's three client-side approximations.
