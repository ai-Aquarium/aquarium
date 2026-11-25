---
title: "feat: Snooze + Dismiss on notification-backed Needs-you cards"
status: implemented
date: 2026-11-25
type: feature
target_repo: aquarium (agent-home + hermes_cli)
---

# Snooze + Dismiss on notification-backed Needs-you cards

## Ask

Notification cards in the Needs-you panel offered only **Open**, which lands
on the `/inbox` list view — not the item. Give them the same two escapes a
suggested task already has: **Snooze** ("not now", comes back later) and
**Dismiss** ("take no action", settles it).

## Design

- **Snooze is a real state, not a UI trick.** `notifications.snoozed_until`
  (TIMESTAMPTZ, migration `ADD COLUMN IF NOT EXISTS`) hides a pending row on
  *every* surface — web, Telegram, anywhere `list_pending` feeds — until the
  stamp passes. The row stays `pending`, so a re-raise over the snooze window
  still collapses onto the same row via its dedupe key, and it returns on its
  own when the stamp passes. Same semantics as a to-do's `snoozed_until`.
- **A snoozed row still covers its wait.** Needs-you callers read
  `list_pending(include_snoozed=True)`; `notification_entries` emits the row
  marked `context.snoozed` so `notification_dedupe_keys` keeps suppressing
  the derived project entry it stands for — otherwise snoozing a "run
  waiting" card would resurface the same wait under a `proj:*` id.
  `finalize` drops marked rows last (after coverage, before counts/push/
  response), and `merge_arrivals` hides a merged card only when *every*
  profile copy is snoozed.
- **Dismiss reuses `answer`.** Answering `"dismissed"` settles the row; no new
  endpoint. The feed only emits a `dismiss` action on entries with **no**
  settle verb of their own — approvals keep Approve/Deny and `todos send`
  proposals keep Send/Revise/Reject, because a non-verdict answer there is
  treated as revision feedback and would relaunch the session.
- **Snooze is available even without dismiss** (verdict entries can still be
  put off) but never on `foreign` items in a widened "Viewing" view — C2
  would refuse anyway.

## What changed

### Backend (`hermes_cli/`)

- `human_comms.py` — `snoozed_until` column + `Notification.snoozed_until`
  field/`as_dict`; `list_pending` filters snoozed rows by default, with an
  `include_snoozed` opt-out for coverage-aware callers; new
  `NotificationStore.snooze(id, principal, until=)` — C2-gated via
  `_load_visible`, conditional `WHERE status='pending'` update (settled rows
  return unchanged, same race rule as `answer`), rejects naive datetimes.
- `needs_you.py` `notification_entries` — appends a `dismiss` POST action
  (`answer: "dismissed"`) only when no action already carries an `endpoint`;
  entries now carry `notification_id`; snoozed rows are marked
  `context.snoozed` (kept for dedupe coverage, dropped in `finalize`;
  `merge_arrivals` keeps a merged card visible while any copy is live);
  `arrival_entries_elsewhere` reads `include_snoozed=True`.
- `web_server.py` needs-you route — `list_pending(include_snoozed=True)` so
  snoozed notifications keep covering their waits.
- `web_server.py` — `POST /api/comms/notifications/{id}/snooze` parses an
  ISO-8601 `until` (naive → UTC), 400s on garbage, forwards C2 404/403.

### agent-home

- `src/lib/api/client.ts` — `snoozeNotification(id, until)`.
- `src/app/api/comms/notifications/[notificationId]/snooze/route.ts` — BFF
  proxy mirroring the answer route; `route-roles.json` entry `signed-in`.
- `src/lib/post.ts` — the `post` helper moved out of `SuggestedTaskList.tsx`
  to break the import cycle `NeedsYouItem → SuggestedTaskList →
  SuggestedTaskCard → NeedsYouItem`.
- `NeedsYouItem.tsx` — `SnoozeButton` (popover with the shared
  `SNOOZE_OPTIONS` 1 min / 1 day / 1 week) + `NotificationActions` (Snooze +
  feed-driven Dismiss), rendered when `entry.notification_id && !foreign`.
- `NeedsYouDetails.tsx` — `EntryActions` renders `SnoozeButton`; the
  Does-section lists `snooze`.
- i18n `needsYou.json` — `actions.Snooze` / `actions.Dismiss` (en + zh-Hant).

## Tests

- `test_needs_you.py` — action list is `["open","dismiss"]` for a bare
  notification; `dismiss` absent on approval and reply rows; snoozed rows
  are marked, dropped by `finalize`, still emit their dedupe key, and
  return when the stamp passes.
- `test_human_comms_e2e.py` — `test_snooze_hides_until_it_expires`
  (pending-surface roundtrip + dedupe-key collapse over the window) and
  `test_snooze_is_c2_scoped_and_settled_items_stay_settled` (member can't
  snooze another's private item; snoozing an answered item is a no-op).
  Needs docker Postgres — skips cleanly without a daemon.
- `NeedsYouItem.test.tsx` — render gate (`notification_id`, `foreign`,
  absent `dismiss`), snooze posts `{until}` to the snooze route, dismiss
  posts the action's endpoint/body.

## Verified

- `pytest tests/hermes_cli/test_needs_you.py test_human_comms.py` — 46 passed;
  e2e file skips without docker (runs in CI).
- `vitest` full suite — green after `route-roles.json` entry; hint-ratchet
  clean on rebased develop (PR #1107's hints).
- `tsc -p . --noEmit` + eslint — clean.

## Not yet verified

- Live roundtrip: snooze a card on `home.*`, confirm it leaves the panel and
  returns after the stamp; dismiss removes it permanently.
