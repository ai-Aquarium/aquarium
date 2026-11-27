# Plan — PR4: Requirements step doc editor (projects detail redesign)

Design: `docs/design/projects-detail-redesign/` — frame "Project detail —
Requirements step" (mocked up in #1134; Yan's formal review is still
pending — user asked to build from the mockups). Fourth PR after spine
(#1135), Runs (#1136), Start run dialog (#1137).

## What

`requirements/RequirementsDoc.tsx` — the brief as a labelled, editable
document replacing the stacked Scope+Inputs list as the step's primary
part:

- **Header**: `Requirements` + `v{N}` pill + `Unsaved changes` warn pill;
  `Attach` (opens `AddToProjectSheet`), `Discard`, `Save as v{N+1}` —
  PATCHes only the edited brief fields via `briefPatch`.
- **GOAL / AUDIENCE** — editable text (`goal`, `target_audience`).
- **SOURCES** — kind-prefixed chips (`FILE x.xlsx`, `LINK …`, `MEM …`)
  over `groupInputLinks`; add row = `FileDropZone` (uploads via
  `useUploadQueue`) + `+ Link` (`LinkNoteInput` → `POST /links`).
- **DONE WHEN** — `description` editable with a live bullet preview, plus
  the agent's **proposed directives** as green rows: `Accept` →
  `POST /directives/{id}/activate`, `Reject` → `…/retire`.
- **Versions rail** (new shared `steps/VersionRail.tsx`, also used by the
  Plan step next): `v{N} · Current` … `v1 · First draft`, a pending
  `v{N+1} · Not saved` row when dirty or proposals wait, and a "Used by"
  footer.

## Approximations (no backend field exists)

- **Requirements `v{N}`**: derived as `1 + landed requirement changes`
  from `GET /changes` — v1 is the first draft, each change a version row
  (author · date · first line). The doc flagged this gap.
- **"Plan was built from v{N}" lineage** isn't stored — the Used-by
  footer names the active plan rev + newest run number instead.
- **Folder-bridge / VPN add buttons** in the mockup have no link kind —
  the add row offers file upload + link/note only.
- Proposed-directive **Reject** uses the existing `retire` endpoint.

## Wiring

- New `reqdoc` part; `STEP_PARTS.requirements = ["reqdoc", "scope"]` —
  the clarify flow stays stacked below the doc; `?tab=inputs` now lands
  on the doc (sources live there). `InputsTab` remains for deep links.
- i18n `reqDoc.*` in en + zh-Hant. All controls hinted (ratchet green).

## Verify

- `npx tsc --noEmit`, eslint touched files — clean.
- `vitest run src/components/projects` — 105 files / 1103 green.
- New `RequirementsDoc.interaction.test.tsx`: doc render, scoped PATCH,
  proposal accept.
