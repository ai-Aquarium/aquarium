"use client";

import { useEffect, useState } from "react";

import { SUGGESTED_TASKS_CHANGED } from "./useSuggestedTasks";

/** Server-side suggested-task count for the Needs-you badge. */
export interface SuggestedTally {
  /** Every suggested task the caller has (staged/open, not snoozed). */
  count: number;
  /** The probed to-do ids that are suggested tasks right now. */
  suggestedTodoIds: ReadonlySet<string>;
}

/**
 * Reads `/api/suggested-tasks/count`, probing `todoIds` (the to-do alerts in
 * Needs you). Re-reads when the ids change, a suggestion changes or the window
 * regains focus. `null` until the first read, or when it fails.
 */
export function useSuggestedTally(todoIds: readonly string[]): SuggestedTally | null {
  const [tally, setTally] = useState<SuggestedTally | null>(null);
  const probe = [...new Set(todoIds)].sort().join(",");

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const qs = probe ? `?todo_ids=${encodeURIComponent(probe)}` : "";
        const res = await fetch(`/api/suggested-tasks/count${qs}`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as
          | { count?: unknown; suggested_todo_ids?: unknown }
          | null;
        if (!live) return;
        if (!res.ok || typeof body?.count !== "number") {
          setTally(null);
          return;
        }
        const ids = Array.isArray(body.suggested_todo_ids) ? body.suggested_todo_ids : [];
        setTally({ count: body.count, suggestedTodoIds: new Set(ids.map(String)) });
      } catch {
        if (live) setTally(null);
      }
    };
    void read();
    const onChange = () => void read();
    window.addEventListener(SUGGESTED_TASKS_CHANGED, onChange);
    window.addEventListener("focus", onChange);
    return () => {
      live = false;
      window.removeEventListener(SUGGESTED_TASKS_CHANGED, onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [probe]);

  return tally;
}

/** The to-do ids the Needs-you alerts are about, for {@link useSuggestedTally}. */
export function alertTodoIds(
  items: readonly { source: string; context?: { todo_id?: string | null } | null }[],
): string[] {
  return items
    .filter((e) => e.source === "todo")
    .map((e) => e.context?.todo_id)
    .filter((id): id is string => !!id);
}
