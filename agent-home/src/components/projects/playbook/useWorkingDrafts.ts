"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PlaybookDraft, PlaybookDraftsResponse } from "@/types";

export const DRAFTS_POLL_MS = 4_000;

/**
 * Every member's working draft, kept live while the page is visible: an
 * agent edits its member's draft from the chat, and the Planning view
 * follows. `onMine` fires when the caller's own draft appears (on load, or once
 * their agent starts one).
 */
export function useWorkingDrafts(
  slug: string,
  enabled: boolean,
  revision: unknown,
  onMine?: (draft: PlaybookDraft) => void,
): { drafts: PlaybookDraft[]; reload: () => void } {
  const [drafts, setDrafts] = useState<PlaybookDraft[]>([]);
  const hadMine = useRef<boolean | null>(null);
  const onMineRef = useRef(onMine);
  useEffect(() => {
    onMineRef.current = onMine;
  }, [onMine]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/playbook/drafts`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as PlaybookDraftsResponse;
      const next = Array.isArray(data.drafts) ? data.drafts : [];
      setDrafts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      const mine = next.find((d) => d.mine);
      if (mine && !hadMine.current) onMineRef.current?.(mine);
      hadMine.current = Boolean(mine);
    } catch {
      // Keep what is shown; the next poll tries again.
    }
  }, [slug]);

  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => void reload(), 0);
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void reload();
    }, DRAFTS_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled, reload, revision]);

  return { drafts, reload: () => void reload() };
}
