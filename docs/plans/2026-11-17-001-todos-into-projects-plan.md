---
title: "plan: keep the system to-do, make the user's to-do a task"
status: draft — Leo approved the direction on 2026-11-17, apart from the triage cap (now replaced by a daily review); open questions below
date: 2026-11-17
type: plan
origin: >
  Leo, 2026-11-17. This rewrite replaces this file's first draft (one private
  "Inbox" project per person). That idea came from the agent, not from Leo, and Leo rejected it.
depends_on:
  - docs/plans/2026-08-11-001-todos-staging-layer-plan.md (what to-dos do today)
  - docs/plans/2026-08-13-001-todos-and-projects-design-revision.md (the to-do → project seam; its "no reverse sync" rule changes here)
  - docs/design/master-plan/feature-groups/FG-32-projects-durable-record.md (§10 seams)
mockup: shared with Leo in the Devin session (standalone HTML, not committed)
---

# Keep the system to-do, make the user's to-do a task

Items marked *(suggestion)* are the agent's ideas. They are **not** part of what Leo
approved, and nothing else in this plan builds on them.

## Leo's words

1. "Ok, I don't want to remove "hermes todos". However, from user's point of view, a "I want
   to do X" is the same as "Task X" which, a task is a project in Aquarium."
2. "I see the difference now...it is two different perspectives: i) a to-do from a system
   point of view; ii) a to-do from an user point of view"
3. "I am good with most of it except that I don't want a cap of 3 asks per batch. But I do
   want the agent to do a daily review and come up with warnings (ask) for user to review
   the triage skills if there are too many asks were raised in a day."

## In one paragraph

There are two kinds of to-do:

- **The system to-do** is the agent's record that "someone asked for something". It stays
  exactly as it is today, behind `hermes todos`, and is never removed.
- **The user's to-do** is simply a **task**, and in Aquarium a task is a one-off project.

Triage keeps writing system to-dos. People see them as **Suggested tasks** in the Inbox, on
Projects and in Needs you. **Work on this** turns a suggestion into a one-off task. Only the
To-dos tile, its pages and its components go away.

## What the user sees (the mockup walks through each)

| Today, in To-dos | After |
|---|---|
| Triage creates a to-do | Triage still creates a system to-do. The person sees it as a **Suggested task**: in the **Inbox** (tagged Email, WhatsApp, Telegram or Calendar), in a strip on **Projects**, and in **Needs you** |
| Work on this / Snooze / Dismiss on the To-dos page | The same three choices on every Suggested task |
| "Work on this" opens a draft session | **Work on this = Start task**: a one-off project with check-in **Manual** ("Every step") and the source message attached |
| Draft and reply on the to-do | Drafted and approved **in the task**, then sent from the mailbox the message came in on |
| To-do stays open after the work is done | The task's system to-do **closes when the task is done** |
| D88 short refs, /todos links | D88 and old /todos links open the right place: the suggestion, or the task once started |
| To-dos tile and pages | Removed |

## How each piece works

1. **System to-do = `hermes todos`, kept.** The store (`todo_store.py`), the CLI
   (`todos_cmd.py`), triage capture through `register_todo`, duplicate collapsing, quiet
   staging with 14-day expiry, the notifier and digest (`todo_notifier.py`), and the
   `todo_outbound` send code all stay. The agent keeps using `hermes todos`.
2. **No cap on triage asks.** Remove the "at most three to-dos per batch/event" rule from
   the four triage skills' `todo-decisions.md` (email, WhatsApp, Telegram, calendar).
   *(suggestion)* The same cap is also enforced in code: `MAX_TODOS_PER_BATCH = 3` in
   `custom/shared/todo_registration.py`, used through `select_candidates` in
   `custom/shared/triage_handlers.py`. Removing the rule only from the skill files would
   leave the cap in place, so remove both.
3. **Daily review.** Once a day the agent counts the asks raised that day. Above a
   threshold it raises an ask: "Triage raised N asks today. Please review the triage
   skills". The threshold is a `config.yaml` setting. Its default, and whether to count per
   profile or per channel, are open questions. *(suggestion)* The ask is an ordinary system
   to-do, so it shows up as a Suggested task tagged "Daily review".
4. **Suggested tasks.** These are the open and staged system to-dos, shown in three places:
   - the **Inbox**, tagged by channel;
   - a strip on **Projects**;
   - **Needs you**.

   Each one offers **Work on this**, **Snooze** or **Dismiss**.
5. **Work on this = Start task.** It goes through the existing Task mode path
   (`POST /api/projects/quick-task`, shown in `TaskView`) with `autonomy: manual`, and
   attaches the source message (`project_links kind='arrival'`). The system to-do links to
   the project (`project_links kind='todo'`), moves to working, and **closes when the
   project is done**. This replaces the "no reverse sync" rule of the 2026-08-13 design
   revision and FG-32 §10.
6. **Replies.** They are drafted and approved inside the task, then sent from the mailbox
   the message came in on. Sending reuses `todo_outbound` / `card_outbound`. Nothing is sent
   without a person's approval, as today.
7. **D-refs and old links.** System to-dos keep their D refs. D88 opens the suggestion, or
   the task once it has been started. Old `/todos` and `/todos/<id>` links redirect the same
   way. *(suggestion)* `/todos` opens Inbox › Suggested tasks.
8. **Migration: all existing to-dos move.**
   - Open and staged ones become Suggested tasks. They are already system to-dos, so nothing
     is copied.
   - Working and review ones become one-off projects, linked back to their to-do.
   - *(suggestion)* Their drafts in `$HERMES_HOME/drafts/todo_<id>/` are attached to the new
     project.
   - *(suggestion)* Done and dismissed to-dos stay as closed system to-dos, visible through
     `hermes todos`.

   Leo's box had 27 to-dos when this was written: 2 open and 3 in review.
9. **Removed:** only the To-dos tile and the agent-home `/todos` pages and components.
   *(suggestion)* The `/api/todos` routes stay, because the Suggested-task surfaces read
   them.

Kept, unrelated to this plan: `tools/todo_tool.py`, the agent's own planning checklist.

## Stages *(suggestion — order and split)*

Each stage ships on its own. No triage ask can be lost, because triage keeps writing
system to-dos the whole time.

| Stage | What ships | To-dos page |
|---|---|---|
| 1 | Suggested tasks in Inbox, Projects and Needs you. Work on this → Start task, with the links and close-on-done | still there |
| 2 | Triage cap removed, daily review added | still there |
| 3 | Migration of working/review to-dos into projects, D-ref and `/todos` redirects | redirects |
| 4 | To-dos tile, pages and components removed | gone |

## Risks

1. **More asks.** With no cap, a busy chat can raise many asks. The daily review is the
   guard, and a bad threshold makes it either noisy or silent.
2. **Two-way link.** A to-do now closes when its project is done. *(suggestion)* We need a
   rule for a project that is archived or fails rather than finishing (see Q3).
3. **Sending.** Replies still need a person's approval. A regression could block a send,
   but must never send something unapproved.
4. **Old links.** D refs, old pushes and bookmarks must all resolve. Stage 3 tests them.

## Open questions for Leo

1. **Daily review threshold:** what should the default number of asks per day be?
2. **Counting:** per profile, or per channel?
3. *(suggestion)* If a task is archived or fails instead of finishing, does its system to-do
   go back to Suggested tasks, or close?
4. *(suggestion)* Done and dismissed to-dos: keep them only in `hermes todos` history, or
   also show them somewhere in the UI?
