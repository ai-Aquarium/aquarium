"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { CHANNELS, channelLabel } from "@/lib/suggested-tasks/channels";

import { SuggestedTaskList } from "./SuggestedTaskList";
import type { UseSuggestedTasks } from "./useSuggestedTasks";

/**
 * Inbox › Suggested tasks: every open or staged system to-do, tagged by the
 * channel it came in on, with a channel filter.
 */
export function SuggestedTasksInbox({
  feed,
  canStart = true,
}: {
  feed: UseSuggestedTasks;
  canStart?: boolean;
}) {
  const [channel, setChannel] = useState("all");
  const present = new Set(feed.items.map((t) => t.channel));
  const channels = [...CHANNELS, ...[...present].filter((c) => !(CHANNELS as readonly string[]).includes(c)).sort()];
  const shown = channel === "all" ? feed.items : feed.items.filter((t) => t.channel === channel);

  return (
    <section data-component="SuggestedTasksInbox" aria-label="Suggested tasks" className="flex flex-col gap-3">
      <div role="group" aria-label="Filter by channel" className="flex flex-wrap gap-1.5">
        {["all", ...channels].map((c) => {
          const count = c === "all" ? feed.items.length : feed.items.filter((t) => t.channel === c).length;
          return (
            <button
              key={c}
              type="button"
              data-channel-filter={c}
              aria-pressed={channel === c}
              onClick={() => setChannel(c)}
              className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-xs ${
                channel === c
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 font-medium text-[var(--color-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)]"
              }`}
            >
              {c === "all" ? "All channels" : channelLabel(c)}
              {count > 0 ? <span className="tabular-nums opacity-70">{count}</span> : null}
            </button>
          );
        })}
      </div>
      {feed.error && feed.items.length === 0 ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {feed.error}
        </p>
      ) : !feed.loaded ? (
        <div aria-hidden className="flex flex-col gap-2">
          <div className="h-28 animate-pulse rounded-2xl bg-[var(--color-surface-2)]" />
          <div className="h-28 animate-pulse rounded-2xl bg-[var(--color-surface-2)]" />
        </div>
      ) : shown.length === 0 ? (
        <p
          data-component="SuggestedTasksEmpty"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          {feed.items.length === 0
            ? "No suggested tasks. When triage spots something you may want to do, it shows here."
            : feed.nextCursor
              ? "None from this channel in the ones loaded so far."
              : "No suggested tasks from this channel."}
        </p>
      ) : (
        <SuggestedTaskList tasks={shown} canStart={canStart} onRemoved={feed.remove} />
      )}
      {feed.nextCursor && feed.loadMore ? (
        <ActionButton
          data-action="suggested-load-more"
          onAction={() => feed.loadMore?.()}
          busyLabel="Loading…"
          className="inline-flex min-h-10 items-center justify-center self-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 text-sm"
        >
          Load more suggestions
        </ActionButton>
      ) : null}
    </section>
  );
}
