# Project detail: sub-tabs inside Planning / Execution

## What changed

`agent-home/src/components/projects/ProjectDetailView.tsx` — each section with
more than one part now renders a second, lighter tab row
(`data-component="ProjectPartsNav"`) directly under `ProjectTabsNav`. Clicking
a sub-tab **switches** which part renders; the other parts stay mounted but
`hidden`, so their state (board scroll, fetched outputs, form drafts) survives
the switch. Log has no parts and shows no second row. On phones, while the
chat tab is open, the row hides with the panel (same `phoneHide` rule).

`agent-home/src/components/projects/tabs/sections.ts` — `?tab=dashboard` now
resolves to `{ section: "execution", part: "dashboard" }` so the deep link
selects the Dashboard sub-tab instead of landing on the section's first part
(`runs`). `work`/`overview` stay section-level.

## Why

Planning stacks Brief / Inputs / Plan / Outputs and Execution stacks Runs /
Dashboard / Board / Iterations into one long page; reaching a sub-section meant
scrolling. Switching sub-tabs give one-tap access with no scrolling and no
state loss. `?tab=` deep links (`?tab=outputs`, readiness `reveal`, old tab
names via `resolveTabParam`) keep working — they now select the sub-tab instead
of scrolling to it (`scrollTo` still runs; the section anchors remain).

## Decisions

- **Mount-but-hide** over conditional render: preserves per-part state and
  keeps SSR output identical in shape; `hidden` attr + `hidden`/`flex` class
  switch (Tailwind `flex` would otherwise override the `hidden` attribute).
- **Sub-row only when `parts.length > 1`** — Log stays single-panel; its own
  filter chips already act as sub-navigation.
- `selectTab`/`selectSection` reset `part` to the resolved part (or the
  section's first); `selectPart` writes `?tab=<part>` for shareable URLs.

## Tests

- New: "switches sub-sections with a second tab row" in
  `ProjectDetailView.test.tsx` — nav renders, first part active, other parts
  `hidden`, deep-link selects the sub-tab, Log shows no row.
- Updated: `sections.test.ts` `dashboard` mapping.
- `vitest run src/components/projects` — 102 files / 1091 tests green; `tsc`
  and `eslint` clean.

## Follow-ups

- Parts nav is not sticky; if long parts make reaching the row a scroll of
  its own, consider making the row sticky under the main tabs.
