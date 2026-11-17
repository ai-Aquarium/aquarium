"use client";

import Link from "next/link";

import { SuggestedTaskList } from "./SuggestedTaskList";
import type { UseSuggestedTasks } from "./useSuggestedTasks";

/** Needs you › Suggested tasks: each one asks the person to start, snooze or dismiss it. */
export function SuggestedTasksNeedsYou({
  feed,
  canStart = true,
}: {
  feed: UseSuggestedTasks;
  canStart?: boolean;
}) {
  if (feed.items.length === 0) return null;
  return (
    <section data-component="SuggestedTasksNeedsYou" aria-labelledby="needs-you-suggested" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 id="needs-you-suggested" className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Suggested tasks · {feed.items.length}
        </h3>
        <Link href="/inbox?tab=suggested" className="inline-flex min-h-9 items-center text-xs text-[var(--color-accent)]">
          See all in Inbox
        </Link>
      </div>
      <SuggestedTaskList tasks={feed.items} compact canStart={canStart} onRemoved={feed.remove} />
    </section>
  );
}
