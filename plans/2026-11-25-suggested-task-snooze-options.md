---
title: "feat: Snooze duration options on suggested-task cards"
status: implemented
date: 2026-11-25
type: feature
target_repo: aquarium (agent-home)
---

# Snooze duration options on suggested-task cards

## Ask

The suggested-task **Snooze** button (landing page `/`, Needs-you strip,
Inbox suggested tab, message side card) hid a task for a fixed 2 hours
(`SNOOZE_HOURS` in `lib/suggested-tasks/channels.ts`). Replace the fixed
duration with three choices: **1 min**, **1 day**, **1 week**.

## What changed

- `src/lib/suggested-tasks/channels.ts` — `SNOOZE_HOURS`/`snoozeUntil(now)`
  replaced by `SNOOZE_OPTIONS` (`1min` / `1day` / `1week`, each with `label`
  + `ms`) and `snoozeUntil(ms, now)`.
- `src/components/suggested-tasks/SuggestedTaskCard.tsx` — the single
  Snooze `ActionButton` is now a `usePopover` trigger (unchanged name,
  `data-action="suggested-snooze"`, `aria-haspopup="menu"`) opening a small
  menu above the button with the three options (`role="menuitem"`,
  `data-snooze=<id>`). The chosen option runs through `ActionButton` so the
  busy spinner still shows on the picked item; the menu closes when the
  action settles. `onSnooze(task, option)` carries the choice.
- `src/components/suggested-tasks/SuggestedTaskList.tsx` — threads the
  option into the POST body (`until: snoozeUntil(option.ms)`) and the
  notice (`Snoozed D88 for 1 day.`).
- `src/components/landing/work/NeedsYouDetails.tsx` — the details panel's
  "Snooze 2h" button gets the same popover; the Does-section label shortens
  to "Snooze".
- i18n `needsYou.json` (en + zh-Hant): the action legend text now describes
  the variable duration.
- `TodoDetailView`'s own snooze row (3 hours / Tomorrow / Next week, on
  `/todos/[id]`) is a different surface — untouched.

## Verified

- `tsc -p . --noEmit` — clean.
- `vitest` `channels.test.ts` + `SuggestedTasks.interaction.test.tsx` —
  13/13 pass (menu contents, `until` ≈ +24 h for "1 day", notice text).
- `eslint` on all changed files — clean.

## Notes for deploy

- Frontend only; the `/api/suggested-tasks/[id]/snooze` route already
  accepts any `until` timestamp — no backend or config change.
- app-mcp: the trigger still reads `button "Snooze"`; the options appear
  in the DOM snapshot only while the menu is open.
