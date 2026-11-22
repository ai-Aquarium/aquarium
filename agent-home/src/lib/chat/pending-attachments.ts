/**
 * Attachments handed to the next chat composer that mounts — how Files →
 * Browse's "Ask the agent about this file" lands in a chat with the file
 * already attached. Held in `sessionStorage` for one page hop, then cleared.
 */
import type { ChatAttachment } from "@/types";

const KEY = "agent-home:pending-attachments";

function isAttachment(value: unknown): value is ChatAttachment {
  const a = value as ChatAttachment;
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.path === "string" &&
    typeof a.name === "string" &&
    typeof a.content_type === "string" &&
    typeof a.size === "number"
  );
}

export function setPendingAttachments(attachments: ChatAttachment[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(attachments));
  } catch {
    // Private mode / storage full: the chat opens without the file.
  }
}

/** Read and clear: each pending attachment reaches one composer only. */
export function takePendingAttachments(): ChatAttachment[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    sessionStorage.removeItem(KEY);
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAttachment) : [];
  } catch {
    return [];
  }
}

const HAND_OFF_KEY = "agent-home:hand-off-attachments";

/**
 * Files the landing composer uploaded for the first message of a new chat.
 * Kept apart from {@link setPendingAttachments} (which fills the composer):
 * these go with the auto-sent first turn, and only with the same text.
 */
export function setHandOffAttachments(text: string, attachments: ChatAttachment[]): void {
  try {
    if (attachments.length === 0) sessionStorage.removeItem(HAND_OFF_KEY);
    else sessionStorage.setItem(HAND_OFF_KEY, JSON.stringify({ text, attachments }));
  } catch {
    // Private mode / storage full: the message goes without the files.
  }
}

/** Read and clear the hand-off; files only when they were sent with `text`. */
export function takeHandOffAttachments(text: string): ChatAttachment[] {
  try {
    const raw = sessionStorage.getItem(HAND_OFF_KEY);
    if (!raw) return [];
    sessionStorage.removeItem(HAND_OFF_KEY);
    const parsed = JSON.parse(raw) as { text?: unknown; attachments?: unknown };
    if (parsed?.text !== text || !Array.isArray(parsed.attachments)) return [];
    return parsed.attachments.filter(isAttachment);
  } catch {
    return [];
  }
}
