"use client";

import Link from "next/link";

import { SuggestedTaskList } from "./SuggestedTaskList";
import { useSuggestedTasks } from "./useSuggestedTasks";

const SHOWN = 3;

/** Projects › the Suggested tasks strip: the first three, then "See all in Inbox". */
export function SuggestedTasksStrip({ canStart = true }: { canStart?: boolean }) {
  const feed = useSuggestedTasks();
  // Nothing suggested: no row at all, to save space.
  if (!feed.loaded || feed.items.length === 0) return null;
  return (
    <section
      data-component="SuggestedTasksStrip"
      aria-labelledby="suggested-strip-heading"
      className="flex flex-col gap-2 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="suggested-strip-heading" className="text-sm font-semibold">
          Suggested tasks · {feed.items.length}
        </h2>
        <Link
          href="/inbox?tab=suggested"
          className="inline-flex min-h-9 items-center text-sm text-[var(--color-accent)]"
        >
          See all in Inbox
        </Link>
      </div>
      <SuggestedTaskList
        tasks={feed.items.slice(0, SHOWN)}
        compact
        canStart={canStart}
        layout="grid"
        onRemoved={feed.remove}
      />
    </section>
  );
}
