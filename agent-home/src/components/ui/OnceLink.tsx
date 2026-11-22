"use client";

import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

import { Spinner } from "@/components/ui/Spinner";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  /** Shown with a spinner after the click, e.g. "Opening…". */
  busyLabel?: ReactNode;
  /** How long further clicks are ignored (a download or new tab never unloads this page). */
  holdMs?: number;
  children: ReactNode;
};

/**
 * A link that acts once: after a plain click it shows `busyLabel`, is
 * `aria-disabled` and drops clicks for `holdMs`, so a slow open or download
 * cannot be started twice. Modifier clicks (open in a new tab) are left alone.
 * Coming back through the browser's back/forward cache resets it.
 */
export function OnceLink({ href, busyLabel, holdMs = 4000, className = "", onClick, children, ...rest }: Props) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => setBusy(false), holdMs);
    return () => window.clearTimeout(timer);
  }, [busy, holdMs]);

  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  return (
    <a
      data-component="OnceLink"
      {...rest}
      href={href}
      aria-disabled={busy || undefined}
      data-busy={busy ? "true" : "false"}
      className={`${className} ${busy ? "pointer-events-none opacity-70" : ""}`}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        onClick?.(e);
        if (!e.defaultPrevented) setBusy(true);
      }}
    >
      {busy ? (
        <>
          <Spinner />
          {busyLabel ?? children}
        </>
      ) : (
        children
      )}
    </a>
  );
}
