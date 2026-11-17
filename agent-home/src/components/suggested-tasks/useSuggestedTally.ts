"use client";

import { useEffect, useState } from "react";

import { SUGGESTED_TASKS_CHANGED } from "./useSuggestedTasks";

/** Server-side suggested-task count for the Needs-you badge. */
export interface SuggestedTally {
  /** Every suggested task the caller has (staged/open, not snoozed). */
  count: number;
}

/**
 * Reads `/api/suggested-tasks/count`. Re-reads when a suggestion changes or
 * the window regains focus. `null` until the first read, or when it fails.
 */
export function useSuggestedTally(): SuggestedTally | null {
  const [tally, setTally] = useState<SuggestedTally | null>(null);

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const res = await fetch("/api/suggested-tasks/count", { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { count?: unknown } | null;
        if (!live) return;
        setTally(res.ok && typeof body?.count === "number" ? { count: body.count } : null);
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
  }, []);

  return tally;
}
