/**
 * Suggested tasks: the open and staged system to-dos (`hermes todos`) shown
 * to the person as "I want to do X" asks. Pure helpers shared by the BFF and
 * the Inbox / Projects / Needs-you surfaces.
 */
import type { SuggestedTask, SuggestedTaskSource, Todo } from "@/types";

/** The channels a suggested task is tagged with, in filter order. */
export const CHANNELS = ["email", "whatsapp", "telegram", "calendar"] as const;

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  calendar: "Calendar",
  imessage: "iMessage",
  slack: "Slack",
  discord: "Discord",
  agent_home: "Aquarium",
  other: "Other",
};

/** "Email", "WhatsApp", … — an unknown surface keeps its own name. */
export function channelLabel(channel: string): string {
  if (CHANNEL_LABEL[channel]) return CHANNEL_LABEL[channel];
  return channel ? channel.charAt(0).toUpperCase() + channel.slice(1).replace(/_/g, " ") : "Other";
}

/** The stages that make a to-do a suggestion: not started, not closed. */
export const SUGGESTED_STAGES = ["open", "staged"] as const;

export function isSuggested(todo: Pick<Todo, "stage">): boolean {
  return (SUGGESTED_STAGES as readonly string[]).includes(todo.stage);
}

/** The channel a to-do came in on: its source message's surface, else `other`. */
export function channelOf(source: Pick<SuggestedTaskSource, "surface"> | null): string {
  const surface = (source?.surface ?? "").trim().toLowerCase();
  return surface || "other";
}

/** Who sent the source message, for one line on a card. */
export function senderOf(source: SuggestedTaskSource | null): string {
  if (!source) return "";
  return (source.sender_name || source.sender_id || "").trim();
}

/** Snooze = "come back tomorrow morning": 09:00 local on the next day. */
export function tomorrowMorning(now: Date = new Date()): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

/**
 * The Start task sheet's prefill: the ask, then the message it came from.
 * The server appends the full source message and the reply rules to the
 * brief either way, so this is only what the person reads and may reword.
 */
export function startRequestText(task: Pick<SuggestedTask, "todo" | "source">): string {
  const { todo, source } = task;
  const parts = [todo.title.trim()];
  const description = (todo.description ?? "").trim();
  if (description && description !== todo.title.trim()) parts.push(description);
  if (source) {
    const who = senderOf(source);
    const body = (source.body ?? "").replace(/\s+/g, " ").trim();
    const quoted = body.length > 400 ? `${body.slice(0, 399)}…` : body;
    const line = [who ? `Source: ${who}` : "Source", quoted ? `— "${quoted}"` : ""]
      .filter(Boolean)
      .join(" ");
    parts.push(line);
  }
  return parts.join("\n\n");
}

/** A suggested task's list row from a to-do and (when readable) its arrival. */
export function toSuggestedTask(todo: Todo, source: SuggestedTaskSource | null): SuggestedTask {
  return { todo, source, channel: channelOf(source) };
}
