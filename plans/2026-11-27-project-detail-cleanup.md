# Project detail page — header dedupe + long-list Requirements

Mockups:

- Figma wireframe (authoritative): https://www.figma.com/design/bw37BmFpLQwPmslP79KzZH
- Canva before/after proposal: https://canva.link/2vfdu7jqgg4cgf0

Prompted by the live page on the HSD box: the header repeats itself (the word
"active" twice, three separate attention signals, two `···` menus, progress
split across the journey bar and the idle strip), and the Requirements step
renders hundreds of source chips as a wall with no grouping, search, or
collapse.

## C1 — Header dedupe (`ProjectDetailView.tsx` + header sub-components)

Today: meta row (`active · repeatable · supervised`), a category row, a
status sentence (`active · 1 needs you`), the JourneyBar card, the
LiveStatusBar card, and the Add/Edit/Summarise toolbar — five stacked
surfaces with overlapping facts.

Proposal:

- **One card.** Title row: project title + `attention · N` pill (only when
  N>0, carries the count) + Latest outputs + Start run + the single `···`.
- **One meta line** under it: `↻ repeatable · supervised · active ·
  <category> · next <date>` — cadence glyph, autonomy, status, category and
  schedule in one muted line; `active` appears once.
- **One status card** replacing JourneyBar+LiveStatusBar: phase chips on
  top → the blocked banner only when a card is blocked → a single footer
  line (`Idle — Run 3 finished · nothing running` + `13 of 14 cards done`)
  + progress bar.
- **One `···` menu** total (drop the second in the meta row; the lifecycle
  menu moves into the toolbar/menu).
- Add / Edit / Summarise + About stays as the toolbar below.

Data is already computed in `ProjectDetailView` (`needsYou`, `meta`,
`statusLine`, `liveRun`) — this is a layout change, not a data change.
Keep every `data-component` hook and `data-action` that tests/appmcp rely
on; the collapsible-on-phone behaviour of the status card is preserved.

## C2 — Requirements long lists (`RequirementsDoc.tsx` + a `SourceList`)

- **Collapsible section headers with counts**: GOAL / SOURCES 333 /
  LINKS n / DIRECTIVES n — each independently collapsible, state persisted
  per-project in localStorage (same `usePersistentState` pattern).
- **Sources as compact rows** once a group exceeds ~8 items: kind tag +
  truncated filename + open affordance, instead of wrapping chips.
- **Group by kind**: Reference / Templates / Links (the grouping
  `groupInputLinks` already provides); each group collapsible with a
  "Show all N" when truncated at ~5 rows.
- **Search + kind filter chips** (All / Ref / Tpl / Links) above the list;
  filters apply across groups.
- Right rail (VERSIONS / USED BY) unchanged.

## Order

C1 and C2 are independent — different components, no shared state — and can
land in either order. Frontend-only; no backend or API changes. Update
`implementation-status.md` when each lands.
