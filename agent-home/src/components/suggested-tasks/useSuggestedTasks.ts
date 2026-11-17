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
  /** Set when more suggestions exist past the loaded pages. */
  nextCursor?: string | null;
  /** The profile the suggestions were read in. */
  profile?: string | null;
  refresh: () => Promise<void>;
  /** Append the next page (no-op at the end). */
  loadMore?: () => Promise<void>;
  /** Drop one row now, before the re-read lands. */
  remove: (todoId: string) => void;
}

type Page = SuggestedTasksResponse & { detail?: string };

/**
 * The caller's suggested tasks (`GET /api/suggested-tasks`), re-read on focus
 * and whenever another surface acts on one. A re-read starts from the first
 * page again; `loadMore` appends the next one.
 */
export function useSuggestedTasks(query = ""): UseSuggestedTasks {
  const [items, setItems] = useState<SuggestedTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const mounted = useRef(true);

  const read = useCallback(
    async (cursor: string | null): Promise<Page | null> => {
      const params = new URLSearchParams(query);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      try {
        const res = await fetch(`/api/suggested-tasks${qs ? `?${qs}` : ""}`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as Page | null;
        if (!mounted.current) return null;
        if (!res.ok || !body || !Array.isArray(body.items)) {
          setError(body?.detail ?? "Couldn't load suggested tasks.");
          return null;
        }
        setError(null);
        setNextCursor(body.next_cursor ?? null);
        setProfile(body.profile ?? null);
        return body;
      } catch {
        if (mounted.current) setError("Couldn't load suggested tasks.");
        return null;
      }
    },
    [query],
  );

  const refresh = useCallback(
    (): Promise<void> =>
      (async () => {
        const page = await read(null);
        if (!mounted.current) return;
        if (page) setItems(page.items);
        setLoaded(true);
      })(),
    [read],
  );

  const loadMore = useCallback(
    (): Promise<void> =>
      (async () => {
        if (!nextCursor) return;
        const page = await read(nextCursor);
        if (!page || !mounted.current) return;
        setItems((prev) => {
          const have = new Set(prev.map((t) => t.todo.id));
          return [...prev, ...page.items.filter((t) => !have.has(t.todo.id))];
        });
      })(),
    [read, nextCursor],
  );

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

  return { items, loaded, error, nextCursor, profile, refresh, loadMore, remove };
}
