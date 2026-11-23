import type { PlaybookStep } from "@/types";

import { textDiff } from "./textDiff";

export type StepChange = "added" | "changed";

function stepSignature(step: PlaybookStep): string {
  const deps = [...(step.depends_on ?? step.needs ?? [])].sort();
  return JSON.stringify([
    step.title ?? "",
    step.body ?? "",
    step.assignee ?? "",
    Boolean(step.checkpoint),
    deps,
  ]);
}

/**
 * What a working draft changes against the revision it started from: which
 * of its paragraphs are new or edited, which steps were added or changed
 * (matched by key), and which of the base's steps it removed.
 */
export function draftChanges(
  base: { body?: string | null; steps?: PlaybookStep[] } | null,
  draft: { body?: string | null; steps?: PlaybookStep[] },
): {
  paragraphs: { text: string; changed: boolean }[];
  steps: Map<string, StepChange>;
  removed: PlaybookStep[];
  count: number;
} {
  const diff = textDiff(base?.body ?? "", draft.body ?? "");
  const before = new Map((base?.steps ?? []).map((s) => [s.key, s]));
  const after = new Set((draft.steps ?? []).map((s) => s.key));
  const steps = new Map<string, StepChange>();
  for (const step of draft.steps ?? []) {
    const old = before.get(step.key);
    if (!old) steps.set(step.key, "added");
    else if (stepSignature(old) !== stepSignature(step)) steps.set(step.key, "changed");
  }
  const removed = (base?.steps ?? []).filter((s) => !after.has(s.key));
  return {
    paragraphs: diff.after.map((row) => ({ text: row.text, changed: row.kind === "added" })),
    steps,
    removed,
    count: diff.added + diff.removed + steps.size + removed.length,
  };
}

/** The quote "Ask about this" puts in the project chat's composer. */
/** Who a draft belongs to, as people read it: their display name, else their id. */
export function draftOwner(draft: { user_id: string; display_name?: string | null }): string {
  return draft.display_name?.trim() || draft.user_id;
}

export function quoteForChat(where: string, text: string): string {
  const lines = text.trim().split(/\r?\n/).map((line) => `> ${line}`);
  return `> **${where}**\n${lines.join("\n")}\n\n`;
}
