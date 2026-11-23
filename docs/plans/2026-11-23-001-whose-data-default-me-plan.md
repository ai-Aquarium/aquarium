---
title: "Whose data: chats, to-dos, Needs you and activity open on just me"
status: active
date: 2026-11-23
type: feature
origin: "Leo: a brand-new owner immediately saw the admin's chats and to-dos. Owner/admin may see others, but not by default; seeing other users' data is by option."
depends_on: FG-38 (docs/design/master-plan/feature-groups/FG-38-data-ownership-and-whose-data.md)
---

# Whose data: default = me (FG-38 follow-up)

Mockup approved 2026-11-23 (standalone HTML, not committed).

## Problem

Owner/admin read paths skip the per-person filter, so a first sign-in shows
everyone's data:

| Surface | Cause |
|---|---|
| Chats list, chat search, pin suggestions, Continue, running chats | `_chat_scope_for` → `None` (all) for the owner |
| To-dos list + facets | `scope_filter` → `TRUE` for the owner |
| Needs you (project cards/runs/outputs/clarify/plans) | `_instance_admin` / `is_owner` bypass |
| Running + Scheduled (project runs, cards, cron) | `_instance_admin` bypass |

## Decisions (Leo, 2026-11-23)

1. Other people's items are **view-only**: Open works, only the person can approve/act.
2. Duties of the owner/admin *role* (data-dictionary drafts/schema/health, source
   claims, chat approvals with no recorded requester, profile suggestions) stay in
   every owner/admin's default view, tagged **Team**.
3. The "Viewing" choice **resets to Just me at every sign-in** (session storage).

## Design

- **Personal view is the default.** An interactive login that sends no `owners=`
  reads as if it had no elevated role: owner/admin see what a member would see of
  their own (own rows, shared rows, rows granted to them). Callers with no login
  (operator dashboard, desktop, services, tests without a subject) are unchanged.
- **`owners=<id,id>` widens, within the existing authority.** It never grants
  more than the role already allows: the owner may name anyone; for chats an
  admin still only reads their own; picker roster = `/api/access/viewable-people`.
  With `owners=` the read uses the real role and is narrowed to rows owned by the
  named people (`owner_user_id` / session `user_id` / requester / project owner).
- **Foreign rows are labelled.** Rows owned by someone else carry `owner_user_id`;
  Needs you entries owned by someone else are `foreign: true` with only an Open
  action. Team entries carry `team: true`.
- Endpoints: `GET /api/sessions`, `/api/sessions/search`, `/api/profiles/sessions`,
  `/api/sessions/pin-suggestions` (always own), `/api/todos` + `/facets`,
  `/api/needs-you`, `/api/activity/running`, `/api/activity/scheduled`.
- Detail/access checks (`_require_chat_access`, opening a chat by link) are
  unchanged: the owner can still open anyone's chat; default lists just don't show it.

## agent-home

- One top-bar **Viewing** chip (FG-38 `WhoseDataPicker` roster) drives Home
  (Chats, pin suggestions, Continue, Needs you, Running, Scheduled), To-dos and Chat.
  Hidden when the roster is only you. Stored in `sessionStorage`, cleared at sign-in.
- Viewing others: amber chip + banner ("You're viewing your data + Leo Lau's",
  Back to just me), name badges on foreign rows, view-only Needs you cards. The bell
  and Continue count/offer only your own.

## Phases

| Phase | What | Status |
|---|---|---|
| 1 | Backend: personal default + `owners=` on the endpoints above; tests | in progress |
| 2 | agent-home Viewing chip, banner, badges, view-only cards; BFF forwards `owners=` | planned |
