"use client";

import { SuggestedTasksNeedsYou } from "@/components/suggested-tasks/SuggestedTasksNeedsYou";
import { type UseSuggestedTasks, useSuggestedTasks } from "@/components/suggested-tasks/useSuggestedTasks";
import type { SuggestedTally } from "@/components/suggested-tasks/useSuggestedTally";
import { useNeedsYouText } from "@/lib/landing/needsYouText";
import { arrivalKeyOf } from "@/lib/suggested-tasks/channels";
import type { NeedsYouEntry } from "@/types/landing";

import { NeedsYouItem } from "./NeedsYouItem";
import { SectionHeader } from "./SectionHeader";
import { SEVERITY_RANK } from "./tone";
import { useNow } from "./usePolled";
import { type NeedsYouFeed, useNeedsYouFeed } from "./useNeedsYouFeed";

const AGE_TICK_MS = 30_000;

/** Most urgent first; the server's order is kept within a severity. */
export function sortBySeverity(items: NeedsYouEntry[]): NeedsYouEntry[] {
  return items
    .map((entry, i) => ({ entry, i }))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.entry.severity] ?? 9) - (SEVERITY_RANK[b.entry.severity] ?? 9) ||
        a.i - b.i,
    )
    .map((x) => x.entry);
}

export type NeedsYouPanelViewProps = Pick<
  NeedsYouFeed,
  "items" | "count" | "newIds" | "loaded" | "stale"
> & {
  onActed?: (entry: NeedsYouEntry) => void;
  /** Suggested tasks (open/staged system to-dos), shown above the rest. */
  suggested?: UseSuggestedTasks;
  /** Viewers see suggested tasks but cannot start one. */
  canStart?: boolean;
  /** Server-side suggested-task count, so the header counts past one page. */
  tally?: SuggestedTally | null;
};

/**
 * A to-do's "something needs you" alert is the same ask as a suggested-task
 * card, so an alert is dropped only when a card on screen stands for it: the
 * same arrival, raised only in the profile the cards were read in. Alerts
 * from other profiles, for messages past the loaded page, without an arrival,
 * and reply approvals (severity approval) all stay.
 */
export function withoutSuggestedAsks(items: NeedsYouEntry[], suggested?: UseSuggestedTasks): NeedsYouEntry[] {
  if (!suggested?.loaded || suggested.error || suggested.items.length === 0) return items;
  const shown = new Set(
    suggested.items.map((t) => arrivalKeyOf(t.source)).filter((k): k is string => k !== null),
  );
  const here = suggested.profile ?? null;
  return items.filter((e) => {
    if (e.source !== "todo" || e.severity === "approval") return true;
    const key = e.context?.arrival_key;
    if (!key || !shown.has(key)) return true;
    const raisedIn = (e.context.profiles ?? [e.context.profile]).filter((p): p is string => !!p);
    return raisedIn.some((p) => p !== here);
  });
}

/**
 * "Needs you" (Figma `work-panel` top half, `5:2`; all-clear `10:237`):
 * one row per waiting item, most urgent first, or the all-clear picture.
 */
export function NeedsYouPanelView({
  items,
  count,
  newIds,
  loaded,
  stale,
  onActed,
  suggested,
  canStart = true,
  tally,
}: NeedsYouPanelViewProps) {
  const now = useNow(true, AGE_TICK_MS);
  const { t } = useNeedsYouText();
  const kept = withoutSuggestedAsks(items, suggested);
  const sorted = sortBySeverity(kept);
  const suggestions = suggested?.items.length ?? 0;
  const shownCount = loaded ? needsYouCount(count, items, suggested, tally) : null;

  return (
    <section
      data-component="NeedsYouPanel"
      data-stale={stale || undefined}
      aria-labelledby="needs-you-heading"
      className={`flex flex-col gap-2 ${stale ? "opacity-60" : ""}`}
    >
      <SectionHeader
        id="needs-you-heading"
        label={t("heading")}
        count={shownCount}
        attention={sorted.length + suggestions > 0}
      />
      {suggested ? <SuggestedTasksNeedsYou feed={suggested} canStart={canStart} /> : null}
      {!loaded ? (
        stale ? (
          <p className="px-3 text-[12px] leading-[16px] text-[var(--color-muted)]">
            {t("retrying")}
          </p>
        ) : (
          <div aria-hidden className="flex flex-col gap-2" data-testid="needs-you-skeleton">
            <div className="h-[102px] animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
            <div className="h-[102px] animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
          </div>
        )
      ) : sorted.length === 0 && suggestions > 0 ? null : sorted.length === 0 ? (
        <div
          data-testid="needs-you-all-clear"
          className="flex flex-col items-center gap-2 py-3 text-center"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/illustrations/needs-you-all-clear@2x.png"
            alt=""
            width={160}
            height={125}
            className="h-[125px] w-[160px] object-contain"
          />
          <p className="text-[13px] font-medium leading-[18px] text-[var(--color-fg)]">
            {t("allClearTitle")}
          </p>
          <p className="text-[12px] font-medium leading-[16px] text-[var(--color-muted)]">
            {t("allClearBody")}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("listLabel")}>
          {sorted.map((entry) => (
            <NeedsYouItem
              key={entry.id}
              entry={entry}
              now={now}
              isNew={newIds.has(entry.id)}
              onActed={onActed}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What Needs you counts: the backend's count, minus the to-do alerts a
 * suggested task stands for, plus every suggested task, quiet (staged) ones
 * included. The top-bar badge and the panel header show the same number.
 *
 * With `tally` (the server-side count) it counts past the loaded page, and
 * drops the alerts the server marked `suggested`, so loading more cards never
 * changes it.
 * Without one it falls back to the loaded cards.
 */
export function needsYouCount(
  count: number,
  items: NeedsYouEntry[],
  suggested?: UseSuggestedTasks,
  tally?: SuggestedTally | null,
): number {
  if (!tally) {
    const kept = withoutSuggestedAsks(items, suggested);
    return Math.max(count - (items.length - kept.length), kept.length) + (suggested?.items.length ?? 0);
  }
  const here = suggested?.profile ?? null;
  const dropped = items.filter((e) => {
    if (e.source !== "todo" || e.severity === "approval") return false;
    if (!e.context?.suggested) return false;
    const raisedIn = (e.context.profiles ?? [e.context.profile]).filter((p): p is string => !!p);
    return !raisedIn.some((p) => p !== here);
  }).length;
  return Math.max(count - dropped, items.length - dropped) + tally.count;
}

/**
 * Self-fetching Needs-you panel. Pass `feed` to share one poll with the page,
 * and `suggested` to share the page's suggested-task read (the badge uses it).
 */
export function NeedsYouPanel({
  feed,
  canStart = true,
  suggested,
  tally,
}: {
  feed?: NeedsYouFeed;
  canStart?: boolean;
  suggested?: UseSuggestedTasks;
  /** The page's server-side suggested-task count, shared with the badge. */
  tally?: SuggestedTally | null;
}) {
  return suggested ? (
    <PanelWith feed={feed} canStart={canStart} suggested={suggested} tally={tally} />
  ) : (
    <PanelReadingSuggestions feed={feed} canStart={canStart} />
  );
}

function PanelReadingSuggestions({ feed, canStart }: { feed?: NeedsYouFeed; canStart: boolean }) {
  return <PanelWith feed={feed} canStart={canStart} suggested={useSuggestedTasks()} />;
}

function PanelWith({
  feed,
  canStart,
  suggested,
  tally,
}: {
  feed?: NeedsYouFeed;
  canStart: boolean;
  suggested: UseSuggestedTasks;
  tally?: SuggestedTally | null;
}) {
  return feed ? (
    <NeedsYouPanelView
      {...feed}
      suggested={suggested}
      tally={tally}
      canStart={canStart}
      onActed={() => void feed.refresh()}
    />
  ) : (
    <OwnFeed suggested={suggested} canStart={canStart} />
  );
}

function OwnFeed({ suggested, canStart }: { suggested: UseSuggestedTasks; canStart: boolean }) {
  const feed = useNeedsYouFeed();
  return <NeedsYouPanelView {...feed} suggested={suggested} canStart={canStart} onActed={() => void feed.refresh()} />;
}
