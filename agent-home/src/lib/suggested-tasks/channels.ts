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

/** Python's `quote(s, safe="")`: everything but `A-Za-z0-9_.-~` is escaped. */
function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The arrival key Needs you groups a message's alerts by
 * (`hermes_cli/needs_you.py#arrival_key`), or null without the channel id.
 */
export function arrivalKeyOf(
  source: Pick<SuggestedTaskSource, "surface" | "account_id" | "external_id"> | null,
): string | null {
  if (!source?.external_id) return null;
  return `arrival:${[source.surface, source.account_id, source.external_id]
    .map((p) => pyQuote(String(p ?? "")))
    .join(":")}`;
}

/** Who sent the source message, for one line on a card. */
export function senderOf(source: SuggestedTaskSource | null): string {
  if (!source) return "";
  return (source.sender_name || source.sender_id || "").trim();
}

/**
 * The Snooze choices on a suggested task: "not now" for this long — a minute
 * to watch it come back, a day, or a week.
 */
export const SNOOZE_OPTIONS = [
  { id: "1min", label: "1 min", ms: 60_000 },
  { id: "1day", label: "1 day", ms: 86_400_000 },
  { id: "1week", label: "1 week", ms: 7 * 86_400_000 },
] as const;
export type SnoozeOption = (typeof SNOOZE_OPTIONS)[number];

/** Snooze = "not now": the task comes back `ms` later. */
export function snoozeUntil(ms: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ms);
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
