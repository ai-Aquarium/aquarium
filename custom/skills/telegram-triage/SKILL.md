---
name: telegram-triage
description: Telegram triage (FG-03 P6) — how a user-profile agent classifies a batch of messages that reached one of the owner's Telegram bots, extracts tasks, to-dos and notes, and decides on escalation.
version: 1.0.0
---

# Telegram Triage

Each batch holds the messages one Telegram chat sent to one bot in a short
window: a direct message (`dm`) or a group the bot is in (`group`). The bot
belongs to exactly one person, the owner you work for; the router already
decided this batch matters to this profile.

## How to read a batch

- **Direct message**: someone is writing to the owner's bot. Treat it like a
  WhatsApp chat with that person.
- **Group**: several senders; most chatter is not for the owner. Look for
  messages that mention or ask the owner (or the bot) for something.
- Messages may carry media (`[media]`) with or without a caption; judge by
  the caption and the context.
- `Receiving Bot` (`tgbot:<bot id>`) is the account any reply leaves from.
  Replies are always drafted for the owner's approval, never sent by you.

## What to produce

One JSON object, exactly as in `response-schema.md`. Use the other skill
files for classification, task extraction, to-do and escalation rules, and
what is worth remembering. When nothing needs the owner, classify it as
`informational` or `ignorable` with empty lists.
