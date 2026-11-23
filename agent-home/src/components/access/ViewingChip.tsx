"use client";

import { useEffect, useState } from "react";

import { WhoseDataPicker } from "@/components/access/WhoseDataPicker";
import { clearViewing, setViewing, useViewing } from "@/lib/viewing";
import type { ViewablePeople } from "@/lib/whose-data";

let roster: Promise<ViewablePeople | null> | null = null;

/** Whom "Viewing" may offer; `null` when it is only you (the chip hides). */
function loadRoster(): Promise<ViewablePeople | null> {
  roster ??= fetch("/api/access/viewable-people", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<ViewablePeople>) : null))
    .then((r) => (r && Array.isArray(r.people) && r.people.length > 1 ? r : null))
    .catch(() => null);
  return roster;
}

export function useViewableRoster(enabled = true): ViewablePeople | null {
  const [people, setPeople] = useState<ViewablePeople | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadRoster().then((r) => {
      if (live) setPeople(r);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return people;
}

function displayName(people: ViewablePeople | null, userId: string): string {
  return people?.people.find((p) => p.user_id === userId)?.display ?? userId;
}

function othersIn(people: ViewablePeople | null, viewing: string[]): string[] {
  return people ? viewing.filter((id) => id !== people.me) : [];
}

const AMBER =
  "border-[var(--color-warn)] bg-[color-mix(in_srgb,var(--color-warn)_12%,transparent)]";

/**
 * Top-bar "Viewing" chip ("Whose data" default = me, FG-38): whose chats,
 * to-dos, Needs you and activity Home, To-dos and Chat show. Hidden for
 * anyone who may only read their own. Amber while it includes other people.
 */
export function ViewingChip({ compact = false }: { compact?: boolean }) {
  const people = useViewableRoster();
  const viewing = useViewing();
  const [open, setOpen] = useState(false);
  if (!people) return null;
  const others = othersIn(people, viewing);
  const label = others.length
    ? `Me + ${others.length === 1 ? displayName(people, others[0]) : `${others.length} people`}`
    : "Just me";
  return (
    <div data-component="ViewingChip" className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-viewing={others.length ? "others" : "me"}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 items-center gap-1 rounded-[var(--radius-full)] border px-3 text-[13px] font-medium text-[var(--color-fg)] ${
          others.length ? AMBER : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
        }`}
      >
        {compact ? null : <span className="hidden text-[var(--color-muted)] sm:inline">Viewing:</span>}
        <span className="max-w-[10rem] truncate">{label}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Whose data to show"
          className="absolute right-0 top-10 z-50 flex w-72 flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg"
        >
          <p className="text-xs text-[var(--color-muted)]">
            Add other people&apos;s chats, to-dos and activity. Their items are view-only, and
            this goes back to Just me when you sign in.
          </p>
          <WhoseDataPicker
            people={people}
            value={viewing.length ? viewing : [people.me]}
            onChange={(owners) => setViewing(owners, people.me)}
          />
          <button
            type="button"
            data-action="viewing-just-me"
            disabled={!others.length}
            onClick={() => {
              clearViewing();
              setOpen(false);
            }}
            className="self-start text-sm font-medium text-[var(--color-accent)] disabled:text-[var(--color-muted)]"
          >
            Back to just me
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The amber line under the bar while "Viewing" includes other people. */
export function ViewingBanner() {
  const people = useViewableRoster();
  const others = othersIn(people, useViewing());
  if (!others.length) return null;
  const names = others.map((id) => displayName(people, id)).join(", ");
  return (
    <div
      role="status"
      data-component="ViewingBanner"
      className={`flex items-center gap-3 border-b px-4 py-1.5 text-[13px] text-[var(--color-fg)] ${AMBER}`}
    >
      <span className="min-w-0 flex-1 truncate">
        You&apos;re viewing your data and {names}&apos;s. Their items are view-only.
      </span>
      <button type="button" onClick={clearViewing} className="shrink-0 font-medium underline">
        Back to just me
      </button>
    </div>
  );
}

const BADGE =
  "shrink-0 rounded-full border px-1.5 text-[11px] font-semibold leading-[16px] text-[var(--color-fg)]";

/** Whose another person's row is, in a wider "Viewing". */
export function OwnerBadge({ userId }: { userId: string }) {
  const people = useViewableRoster();
  return (
    <span data-component="OwnerBadge" className={`${BADGE} ${AMBER}`} title="View-only: only they can act on it">
      {displayName(people, userId)}
    </span>
  );
}

/** A duty of the owner/admin role rather than of one person. */
export function TeamBadge() {
  return (
    <span data-component="TeamBadge" className={`${BADGE} border-[var(--color-border)] bg-[var(--color-surface-2)]`}>
      Team
    </span>
  );
}

/** On the sign-in page: every session opens on "Just me". */
export function ResetViewing() {
  useEffect(() => {
    clearViewing();
  }, []);
  return null;
}
