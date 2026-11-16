"use client";

import { useCallback, useEffect, useRef } from "react";

import type { AskOptions } from "@/components/ui/useConfirm";

const DISCARD: AskOptions = {
  title: "Discard unsaved changes?",
  body: "You have unsaved changes to your triage skills. They are lost if you leave now.",
  confirmLabel: "Discard",
  tone: "danger",
};

/**
 * While `dirty`, warn before the tab closes and before any in-app link
 * navigates. Returns `confirmDiscard()` for in-page switches (tabs, files).
 */
export function useUnsavedGuard(dirty: boolean, ask: (opts: AskOptions) => Promise<boolean>): () => Promise<boolean> {
  const leaving = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a || a.getAttribute("target") === "_blank" || a.hasAttribute("download")) return;
      if ((a.getAttribute("href") ?? "").startsWith("#")) return;
      e.preventDefault();
      e.stopPropagation();
      void ask({ ...DISCARD, confirmLabel: "Leave" }).then((leave) => {
        if (!leave) return;
        leaving.current = true;
        (a as HTMLAnchorElement).click();
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, ask]);

  return useCallback(async () => !dirty || ask(DISCARD), [dirty, ask]);
}

export type ReportDirty = (part: string, dirty: boolean) => void;

/** Tell the page whether this editor has unsaved text; clears itself on unmount. */
export function useReportDirty(part: string, dirty: boolean, report: ReportDirty): void {
  useEffect(() => {
    report(part, dirty);
  }, [part, dirty, report]);
  useEffect(() => () => report(part, false), [part, report]);
}
