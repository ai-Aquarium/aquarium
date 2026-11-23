/**
 * "Viewing" — whose data the signed-in owner/admin is looking at across Home,
 * To-dos and Chat ("Whose data" default = me, FG-38). Kept in this tab's
 * sessionStorage and cleared at every sign-in and sign-out, so a session
 * always opens on "Just me". Empty means just me: no `owners=` is sent and
 * the server returns only the caller's own. It is a filter, never access:
 * the server re-checks every read.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import { MAX_OWNERS } from "@/lib/whose-data";

const KEY = "aquarium.viewing.owners";
const EVENT = "aquarium:viewing";
const NONE: string[] = [];
let cache: { raw: string | null; owners: string[] } = { raw: null, owners: NONE };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The people being viewed besides the caller's own, or `[]` for just me. */
export function readViewing(): string[] {
  const raw = storage()?.getItem(KEY) ?? null;
  if (raw === cache.raw) return cache.owners;
  let owners: string[] = NONE;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      owners = parsed.filter((v): v is string => typeof v === "string" && !!v).slice(0, MAX_OWNERS);
    }
  } catch {
    owners = NONE;
  }
  cache = { raw, owners };
  return owners;
}

/** View `owners` (the caller included); just the caller clears the view. */
export function setViewing(owners: string[], me: string): void {
  const store = storage();
  if (!store) return;
  const unique = [...new Set(owners)].slice(0, MAX_OWNERS);
  if (!unique.some((id) => id !== me)) store.removeItem(KEY);
  else store.setItem(KEY, JSON.stringify(unique.includes(me) ? unique : [me, ...unique]));
  window.dispatchEvent(new Event(EVENT));
}

/** Back to "Just me" (sign-in, sign-out, the banner's button). */
export function clearViewing(): void {
  storage()?.removeItem(KEY);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The current view; `[]` (just me) on the server and the first render. */
export function useViewing(): string[] {
  return useSyncExternalStore(subscribe, readViewing, () => NONE);
}

/**
 * Run `onChange` when the view changes after mount (fetchers read
 * `readViewing()` at call time). `initial`: also on mount when the view is
 * not just me — for a page whose first rows the server rendered as just me.
 */
export function useOnViewingChange(onChange: () => void, opts: { initial?: boolean } = {}): void {
  const key = useViewing().join(",");
  const seen = useRef<string | null>(null);
  const latest = useRef(onChange);
  const initial = Boolean(opts.initial);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const now = readViewing().join(",");
    const first = seen.current === null;
    if (!first && now === seen.current) return;
    seen.current = now;
    if (!first || (initial && now)) latest.current();
  }, [key, initial]);
}

/** `url` with `owners=` when the view includes other people. */
export function withOwners(url: string, owners: string[]): string {
  if (!owners.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}owners=${encodeURIComponent(owners.join(","))}`;
}
