"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SuggestedTask, SuggestedTasksResponse } from "@/types";

/** Fired after Work on this / Snooze / Dismiss so every open surface re-reads. */
export const SUGGESTED_TASKS_CHANGED = "suggested-tasks:changed";

export function announceSuggestedTasksChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SUGGESTED_TASKS_CHANGED));
}

export interface UseSuggestedTasks {
  items: SuggestedTask[];
  /** The first read finished (ok or not). */
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Drop one row now, before the re-read lands. */
  remove: (todoId: string) => void;
}

/**
 * The caller's suggested tasks (`GET /api/suggested-tasks`), re-read on focus
 * and whenever another surface acts on one.
 */
export function useSuggestedTasks(query = ""): UseSuggestedTasks {
  const [items, setItems] = useState<SuggestedTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback((): Promise<void> => (async () => {
    try {
      const res = await fetch(`/api/suggested-tasks${query ? `?${query}` : ""}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as
        | (SuggestedTasksResponse & { detail?: string })
        | null;
      if (!mounted.current) return;
      if (!res.ok || !body || !Array.isArray(body.items)) {
        setError(body?.detail ?? "Couldn't load suggested tasks.");
      } else {
        setItems(body.items);
        setError(null);
      }
    } catch {
      if (mounted.current) setError("Couldn't load suggested tasks.");
    } finally {
      if (mounted.current) setLoaded(true);
    }
  })(), [query]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(SUGGESTED_TASKS_CHANGED, onChange);
    window.addEventListener("focus", onChange);
    return () => {
      mounted.current = false;
      window.removeEventListener(SUGGESTED_TASKS_CHANGED, onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [refresh]);

  const remove = useCallback((todoId: string) => {
    setItems((prev) => prev.filter((t) => t.todo.id !== todoId));
  }, []);

  return { items, loaded, error, refresh, remove };
}
