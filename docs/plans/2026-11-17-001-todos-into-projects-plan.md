---
title: "plan: move To-dos into Projects, then remove To-dos in stages"
status: draft — Leo decided Q3, Q4 and Q6 (2026-11-17); Q1, Q2 and Q5 still open
date: 2026-11-17
type: plan
origin: >
  Leo — "Write a short plan to move triage, \"Work on this\", replies and alerts into Projects,
  then remove To-dos in stages, with a mockup first". To-dos are redundant because Projects covers them.
depends_on:
  - docs/plans/2026-08-11-001-todos-staging-layer-plan.md (what To-dos do today)
  - docs/plans/2026-08-13-001-todos-and-projects-design-revision.md (the to-do → card seam)
  - docs/design/master-plan/feature-groups/FG-32-projects-durable-record.md (§10 seams)
  - hermes_cli/card_outbound.py (#931/#932 — cards already propose email/WhatsApp, a person approves)
mockup: shared with Leo in the Devin session (standalone HTML, not committed)
---

# Move To-dos into Projects, then remove To-dos

## In one paragraph

Today there are two places for "things that need me": the **To-dos** page (where triage
puts asks it finds in email, WhatsApp, Telegram and calendar) and **Projects** (cards on a
board, with a worker, approvals and Needs you). They do the same job twice. This plan gives
every person one private **Inbox** project. Triage puts each ask there as a card in its
**Triage** column. "Work on this" runs the card, the draft shows up in **Review**, a reply
is approved from **Needs you**, and a card can be moved into a real project at any time.
Once that works, To-dos is switched off in four small stages. No triage ask is lost at any
stage, and old links keep working.

## What the user sees (the mockup walks through each)

| Today, in To-dos | After, in Projects |
|---|---|
| Triage creates a to-do (silent "staged", or "open" with a ping) | Triage creates a card in **Inbox › Triage**. **Every** new ask shows in **Needs you**; urgent ones also send a push |
| To-dos page with filters | **Inbox** project board: Triage · Working · Review · Done. Same filters (priority, source, due) |
| "Work on this" starts a draft session | **Work on this** on the card starts the card worker. The card moves to Working, then Review |
| Draft (DRAFT.md / REPLY.txt) on the to-do | Draft and reply in the card's **Draft** tab, editable before sending |
| Reply approval ("hermes todos send") | Card send approval (exists today for cards): **Approve & send**, **Ask for changes**, **Don't send**. `hermes todos send` keeps working |
| Promote to project | **Move to project…** (the card keeps its history). Triage can also suggest a project ("Looks like *Tender 2027*") |
| Snooze / Done / Dismiss | Same three verbs on the card. Dismiss = Archive |
| Badge on the To-dos tile | Badge on the **Projects** tile (Triage + Needs you count). The To-dos tile goes away |
| Inbox message → "Make a to-do" / "To-dos from this" | Inbox message → **Add to Inbox project** / **Cards from this message** |
| D88 short refs | D88 still opens the same item (now a card, e.g. T1204). New asks get T refs |
| /todos, /todos/<id> links (old pushes, bookmarks) | Redirect to the Inbox project / the matching card, with a one-line "To-dos moved to Projects" note |

## Where triage asks land — default and alternatives

**Default (A): one private "Inbox" project per person, asks land in its Triage column.**
Created automatically the first time triage finds an ask for that person. Private (only the
owner sees it; see risk 1 about admins), autonomy **Manual** so nothing runs until the
person taps Work on this, no schedule, no plan. It looks like any other project, so there
is nothing new to learn.

Alternatives considered:

- **(B) Route straight into a matching project** (by contact, thread or project keywords),
  falling back to Inbox. Smart, but a wrong guess hides an ask inside a project the person
  is not looking at. *Proposed as a later add-on:* triage only **suggests** a project on the
  card, one tap moves it.
- **(C) A shared "Triage" project per mailbox/channel** (e.g. one for the sales@ mailbox,
  visible to its team). Good for team inboxes, but personal asks would leak to the team.
  Could be an opt-in per mailbox later.
- **(D) No project — a "Triage" lane on the Projects home page.** Cards without a project
  are out of scope today (Incomings plan) and would need a new board type. Rejected.

## How each piece moves

1. **Triage → card.** The four triage skills keep their rules (`todo-decisions.md` becomes
   `ask-decisions.md`, same criteria, still hot-reloaded). The writer
   (`custom/shared/todo_registration.py`) is replaced by a card writer: title, why,
   priority, due date, a link to the message (`project_links kind='arrival'`), at most 3
   per batch, and the same duplicate check (same message + same title = same card).
   "Staged" (silent) vs "open" (ping) becomes a `notify` flag on the card: it only decides
   whether a push is sent. Every new ask is listed in Needs you either way (Leo, Q3).
   Quiet cards untouched for 14 days are archived, as staged to-dos expire today.
2. **Work on this, drafts and revisions.** Work on this = move the card Triage → Ready, so
   the existing card worker runs it with the message as context. The draft lives in the
   card workspace (replaces `$HERMES_HOME/drafts/todo_<id>`). "Ask for changes" puts the
   note on the card and re-runs it — the loop `card_outbound` already has. A skill's
   `auto_start` (work requests, e.g. a quotation) creates the card straight in Ready.
3. **Replies and approvals.** The worker proposes the reply with
   `hermes projects propose-send` (`card_outbound`, shipped in #931/#932): the exact text,
   sending account and attachment are stored on the card and nothing leaves until a person
   approves. The reply goes out from the same account the message came in on (as today).
   The shared sender (`todo_outbound.deliver_message`) moves to a neutral module first,
   because cards already use it.
4. **Alerts and Needs you.** `todo:` and `todo-action:` notification keys are replaced by
   card keys: every new ask = a Needs you item ("New ask", or "New urgent ask" plus a push)
   linking to the card; it leaves Needs you once worked, snoozed, moved or done; a reply =
   the existing card send approval. Quiet hours, rate limits and the once-only ping rule
   from `todo_notifier.py` are kept by reusing the same notification store.
5. **Inbox links.** `IncomingDetailView`, landing Incomings and Files change "Make a to-do"
   to "Add to Inbox project" (the existing `AddToProjectSheet`, Inbox pre-selected) and
   "To-dos from this" to "Cards from this message". The Incomings "triage made a to-do"
   reason becomes "triage made a card".
6. **Short refs (D88).** Every migrated to-do gets a card ref (T…) and keeps its D ref as an
   alias, so typing D88 or opening an old link finds the card. No new D refs are made.
7. **Existing data.** Small today: on Leo's box 27 to-dos, 5 still live (2 open, 3 in
   review with drafts), 3 draft folders. A one-off, re-runnable migration moves **all**
   of them (Leo, Q4): live → Triage/Working/Review, done → Done, dismissed → Archived, drafts copied
   into the card workspace, history copied onto the card. Each install (HSD too) runs it on
   upgrade and prints a count. The old rows are left in the database, untouched (no delete).

## Staged removal — each stage ships on its own

| Stage | What ships | To-dos still work? | Why no ask is lost |
|---|---|---|---|
| **0** | This plan + mockup, Leo approves | yes | nothing changes |
| **1** | Inbox project, Triage column, card Draft tab, Work on this / Snooze / Move to project on cards, "Add to Inbox project" from messages | yes, unchanged | triage still writes to-dos |
| **2** | Triage writes cards instead of to-dos (setting `triage.asks_to: projects`, default on). Needs you + push for urgent asks. If a card can't be written, it falls back to a to-do and logs it | yes, for old items | one writer at a time (no duplicates), fallback on failure, flip the setting back to undo |
| **3** | Migration of existing to-dos, D-ref aliases, /todos redirects, To-dos tile hidden, badge moves to Projects. Old pending reply approvals keep working until answered | read-only, then gone from the menu | everything live was moved first; the migration refuses to finish while a to-do is mid-send |
| **4** | Delete the old To-dos internals: `todos_api.py`, `todo_work.py`, `todo_outbound.py` (after its sender moved), `todo_notifier.py`, `todo_registration.py`, agent-home `/todos` pages, components, BFF routes, i18n, tests, coral tile. `/todos` redirects stay. **`hermes todos` stays** (Leo, Q6) | the `hermes todos` command, now on Inbox cards | stage 3 has run on every install; the upgrade checks it |

**`hermes todos` stays (Leo, Q6).** Projects does not use it underneath: to-dos are rows in
the Postgres `tasks` table, while Projects cards are Hermes kanban cards in SQLite
(`kanban.db` + `projects.db`, driven by `hermes kanban` / `hermes projects`). So from stage 2
`hermes todos list/show/add/stage/done/snooze/send` keeps its verbs and output but reads and
writes the person's Inbox cards; D refs and T refs both work as ids.

Also kept on purpose: `tools/todo_tool.py` and the desktop app's chat "todo" list
(`apps/desktop/src/lib/todos.ts`, `store/todos.ts`) — that is the agent's own planning
checklist, not this feature. The FG-06 `tasks` table stays (other code reads it); its
to-do columns are just no longer written.

## Risks

1. **Privacy.** A to-do is private to its person; only the box **owner** can see everyone's.
   Cards are wider: a private card is visible to its person, the box owner **and box admins**. Moving asks there means admins
   could read other people's triaged mail asks unless we keep admins out of Inbox projects.
2. **Volume.** Triage makes a lot of asks; a busy Inbox board, and Needs you (which now
   lists every new ask), can get long. Mitigations:
   the 3-per-batch cap, 14-day auto-archive of silent asks, and filters on the board.
3. **Two stores while moving.** Between stages 2 and 3 old to-dos and new cards coexist.
   The Needs you list and badge must count both, or people miss something.
4. **Sending.** Card sends need a signed-in person to approve (#932); that matches today. A
   regression here would mean a reply can't be sent, never that one goes out unapproved.
5. **Bookmarks and old pushes.** Covered by redirects and D-ref aliases; tested on stage 3.
6. **Other installs.** HSD and other boxes upgrade on their own schedule; stage 4 refuses to
   install where stage 3's migration has not run.

## Open questions for Leo

1. **Where asks land.** Default A (private Inbox project per person). OK, or do you want
   B (route into matching projects) or C (shared triage project per team mailbox) now?
   *Example:* Ada emails sales@ about the tender deadline. A: a card in Leo's Inbox › Triage.
   B: a card in the *Tender 2027* project's Triage column (Ada is a contact there).
   C: a card in a shared *sales@ triage* project that the whole sales team sees.
2. **Admin visibility.** Should admins be able to see other people's Inbox cards (as with
   private cards today), or only the person (plus the box owner, as with To-dos)?
   *Example:* triage makes Leo a card "Reply to the bank about the loan rate". Can Grace,
   a box admin, open it?
3. ~~Silent vs urgent~~ — **decided:** every new ask shows in Needs you.
4. ~~Old data~~ — **decided:** migrate all to-dos, including done and dismissed.
5. **Name.** The new project's name. "Inbox" is already the Apps tile for all messages, so
   you would see "Inbox" twice (Apps › Inbox = messages; Projects › Inbox = asks).
   Alternatives: "My asks", "Triage", "Follow-ups".
6. ~~CLI~~ — **decided:** keep `hermes todos`, re-pointed at Inbox cards.
