# Needs-you: show card source (project) + source/owner filters

Show where each "Needs you" card comes from (source kind + project name) and add a collapsible filter row — grouped source-kind chips and Me/Team/Others chips — to the landing Needs-you panel in agent-home.

## Summary

Every `NeedsYouEntry` already carries a `source` kind and, for project waits, `context.project_slug`, plus `team` / `foreign` / `owner_user_id` for whose wait it is — the UI just never displays or filters on them. This change adds a **source line on each card** ("Project · <name>" or the kind label) and a **collapsible filter row** (grouped source chips + who chips) on the landing Needs-you panel. Suggested tasks join the filter as their own bucket.

Decisions confirmed with the user: grouped-kind chips only (no per-project sub-filter), local Me/Team chips *plus* named-people chips when the "Viewing" view is widened, suggested tasks included as one bucket, collapsible filter row under the header.

## Mockup (approved direction)

```
  NEEDS YOU  139                        ⌄ Filter ·1
  ┌─ Filter ────────────────────────────────────┐
  │ SOURCE                                      │
  │  All   (✓Projects ·8)  Suggested ·2         │
  │        Messages & to-dos ·64   Approvals ·3 │
  │        Data dictionary ·12     Other ·50    │
  │ WHO                                         │
  │ (✓Me)   Team ·9   Others ·2 ▾               │
  └─────────────────────────────────────────────┘
  Showing 9 of 139                          Reset
  ┌───────────────────────────────────────────┐
  │ ⚠  WhatsAppHistory mirror · run 4 is      │
  │    waiting on you               Details ⌄ │
  │    ◈ Project · WhatsAppHistory mirror ·3d │  ← new source line
  │    [ Continue… ]                          │
  └───────────────────────────────────────────┘
```

## Source inventory (answers "how many types of sources")

`NeedsYouSource` in `agent-home/src/types/landing.ts` — 18 values, plus the separate suggested-tasks feed:

| Filter bucket | `entry.source` values | Notes |
|---|---|---|
| Suggested tasks | *(separate feed)* `useSuggestedTasks` — to-dos with `source_kind` ∈ inbound/analysis/user/agent/cron | caller-scoped, always "me" |
| Projects | `project_checkpoint`, `budget`, `card_wait`, `card_approval`, `card_blocked`, `output_acceptance`, `clarify`, `plan_approval` | all carry `context.project_slug` |
| Approvals | `chat_tool_approval`, `webview_approval`, `source_claim` | non-project approvals |
| Messages & to-dos | `todo`, `notification` | to-do alerts, reply approvals, triage/proactive asks |
| Data dictionary | `data_draft`, `data_schema`, `data_health` | marked `team` today |
| Other | `profile_suggestion`, `pin_suggestion`, anything unmapped | `pin_suggestion` is declared but never emitted |

Owner dimension: `entry.foreign` + `owner_user_id` = someone else's (only present when "Viewing" includes them); `entry.team` = role duty; otherwise mine.

## Implementation Steps

### Backend (Python, `hermes_cli/`)

1. **`hermes_cli/needs_you.py`** — add a helper `with_project_names(items)` that collects every `context.project_slug`, resolves slug → `project.name` via `projects_db` in one connection, and sets `context.project_name` on each entry (leaving `project_slug` untouched for hrefs/filters). In `project_entries` the name is already in hand; notification-derived rows (`notif:`) only have the slug, so resolving centrally in the route covers both.
2. **`hermes_cli/web_server.py`** (`needs_you` route, ~L13614) — call `ny.with_project_names(items)` before `ny.finalize(items)`, inside its own try/except like the other sources (failure just means cards show slugs).

### Frontend types & i18n

3. **`agent-home/src/types/landing.ts`** — add `project_name?: string | null` to `NeedsYouEntry.context`.
4. **`agent-home/src/i18n/messages/{en,zh-Hant}/needsYou.json`** — new keys:
   - `filter.*`: `label` ("Filter"), `source` ("Source"), `who` ("Who"), `all`, `reset`, `showing` ("Showing {n} of {total}"), bucket labels (`suggested`, `projects`, `approvals`, `messages`, `data`, `other`), who labels (`me`, `team`, `others`)
   - `sources.*`: per-card labels — `project` ("Project · {name}"), `chat_tool_approval`, `webview_approval`, `todo`, `notification`, `profile_suggestion`, `pin_suggestion`, `data_draft`, `data_schema`, `data_health`, `source_claim`
   - `suggestedOrigin.*`: `analysis`/`user`/`agent`/`cron` labels for non-inbound suggested tasks ("System insight", "Added by you", "Agent", "Scheduled")
   - zh-Hant translations for all of the above (mirror existing file's structure).

### Frontend model + filter bar (new file)

5. **`agent-home/src/components/landing/work/needsYouFilter.ts`** — pure, testable model:
   - `sourceGroupOf(entry) → "projects" | "approvals" | "messages" | "data" | "other"` (projects = has `context.project_slug` OR one of the 8 project sources — belt & braces).
   - `facetsOf(items, suggested) → { groups: {id,count}[], projects: {slug,name,count}[], owners: {team:number, others: Map<userId,count>} }` — chips are built from what's actually loaded, like `IncomingsFilters` does from facets.
   - `applyFilter(items, suggested, filter) → {entries, suggested}` — an entry passes if its group is selected (or All) AND its who-bucket is selected; a suggested task passes when the `suggested` bucket is on. Foreign rows only ever appear when Viewing already includes them, so `others` selections never widen the data.
   - `NeedsYouFilter` type: `{ groups: string[] (empty=all), who: Set<"me"|"team"|userId> (empty=all) }`.

6. **`NeedsYouPanel.tsx`** — in `NeedsYouPanelView`:
   - Add `useState` for `{filterOpen, filter}` (component-local, not persisted).
   - `SectionHeader` gets `trailing={<FilterToggleButton/>}` — shows `Filter` or `Filter ·N` while filters are active.
   - Expanded area (between header and content): the `Chip` pattern from `IncomingsFilters` — row `SOURCE` (All + one chip per group present with counts) then row `WHO` (`Me`, `Team ·n`, and one chip per foreign `owner_user_id` resolved via `useViewableRoster()` for display names — chips appear only for owners actually in the list).
   - "Showing X of N · Reset" line when a filter is active; `Reset` restores All.
   - Apply `withoutSuggestedAsks` then the filter to get `sorted`; pass filtered suggested items to `SuggestedTasksNeedsYou` (extend it to accept a pre-filtered `items` or render it only when the suggested bucket is on and let each card pass).
   - Header `count` semantics stay the global tally; the "Showing X of N" line communicates the narrowed view.

7. **`NeedsYouItem.tsx`** — prepend a source line in the existing muted "source" paragraph (data-testid stays):
   - `entry.context.project_slug` → `◈ Project · {project_name ?? project_slug}`
   - else → kind label from `sources.*` (e.g. `Chat approval`, `To-do`, `Message`, `Dictionary draft`, `Source claim`).
   - Keep `detail · age` appended after it (existing behaviour preserved).

8. **`SuggestedTaskCard.tsx`** — when `compact` and `todo.source_kind !== "inbound"`, add a small muted tag next to `ChannelTag` labelled via `suggestedOrigin.*` ("System insight" / "Added by you" / "Agent" / "Scheduled"), so system-generated suggestions no longer read as channel "Other" alone.

9. **`SuggestedTasksNeedsYou.tsx`** — accept an optional `items` override so the panel can hide the section when its bucket is off (or show it filtered). Keep "See all in Inbox" link.

### Tests

10. **`needsYouFilter.test.ts`** (new) — group mapping covers every `NeedsYouSource` value (contract test, not snapshot), facets counts, `applyFilter` semantics, foreign/team/mine classification.
11. **`NeedsYouPanel.test.tsx`** — filter button toggles the row; picking a bucket hides/shows items; Me/Team/person chips; "Showing X of N"; suggested-tasks bucket toggles that section; reset.
12. **`NeedsYouItem.test.tsx`** — the source line shows `Project · <name>` (name preferred over slug) and the right kind label for non-project entries.
13. **`tests/hermes_cli/test_needs_you.py`** — `with_project_names` fills `context.project_name` from `projects_db` for both `project_entries` rows and `notif:` rows; entries without a slug unchanged.

### Repo bookkeeping (project rule)

14. Copy this plan to `plans/` in the repo (e.g. `plans/2026-11-25-needs-you-source-filters.md`) and update `plans/implementation-status.md` when implementing.

## Files to modify

- `hermes_cli/needs_you.py` — `with_project_names()` helper
- `hermes_cli/web_server.py` — call it in the `needs_you` route
- `agent-home/src/types/landing.ts` — `context.project_name`
- `agent-home/src/i18n/messages/en/needsYou.json`, `…/zh-Hant/needsYou.json` — filter + source labels
- `agent-home/src/components/landing/work/needsYouFilter.ts` — new pure model
- `agent-home/src/components/landing/work/NeedsYouPanel.tsx` — filter row + wiring
- `agent-home/src/components/landing/work/NeedsYouItem.tsx` — source line on cards
- `agent-home/src/components/suggested-tasks/SuggestedTaskCard.tsx` — non-inbound origin tag
- `agent-home/src/components/suggested-tasks/SuggestedTasksNeedsYou.tsx` — filterable items prop
- tests: `needsYouFilter.test.ts` (new), `NeedsYouPanel.test.tsx`, `NeedsYouItem.test.tsx`, `tests/hermes_cli/test_needs_you.py`
- `plans/` — check in this plan + update `plans/implementation-status.md`

## Verification

- [ ] `cd agent-home && npm run test` (vitest) — new + touched test files
- [ ] `cd agent-home && npx tsc --noEmit` and eslint on touched files
- [ ] `pytest tests/hermes_cli/test_needs_you.py` — backend helper
- [ ] Manual: `agent-home` dev server → landing "Needs you": cards show `◈ Project · <name>`; filter row expands; Projects chip narrows to project cards; Me/Team/people chips narrow correctly; suggested-task bucket toggles that section; "Showing X of N · Reset" behaves; no filters → identical to today.

## Risks / considerations

- **Counts vs filters**: `count`/`by_severity` are server-side totals; filtered "Showing X" uses loaded items only. The header keeps the true total; the "Showing X of N" line avoids implying the total changed.
- **`project_name` freshness**: resolved per poll, so a rename lands within one 15 s cycle. Slug stays the filter key.
- **Suggested tasks are caller-scoped**: they always count as "me"; the Who filter doesn't hide them (they're only affected by the Suggested-tasks bucket) — matching how the rest of the page treats them.
- **Out of scope (kept simple)**: no per-project sub-filter, no persistence of filter state across reloads, no server-side filtering (items are already loaded; `_PER_SOURCE_LIMIT` = 100 per source makes client-side fine), no changes to the top-bar AttentionStrip/Banner or per-project NeedsYouStrip.
