"use client";

import { useEffect, useMemo, useState } from "react";

import { SuggestedTasksNeedsYou } from "@/components/suggested-tasks/SuggestedTasksNeedsYou";
import {
  type UseSuggestedTasks,
  useSuggestedTasks,
} from "@/components/suggested-tasks/useSuggestedTasks";
import { useViewableRoster } from "@/components/access/ViewingChip";
import { FilterIcon } from "@/components/ui/icons";
import { useNeedsYouText } from "@/lib/landing/needsYouText";
import { usePersistentState } from "@/lib/use-persistent-state";
import { arrivalKeyOf } from "@/lib/suggested-tasks/channels";
import type { NeedsYouEntry } from "@/types/landing";

import {
  type DraftRevision,
  type NeedsYouDetailItem,
  NeedsYouDetails,
} from "./NeedsYouDetails";
import { NeedsYouItem } from "./NeedsYouItem";
import {
  EMPTY_FILTER,
  activeFilterCount,
  applyFilter,
  facetsOf,
  filterIsActive,
  parseFilter,
  serializeFilter,
  type NeedsYouFilter,
  type SourceGroup,
} from "./needsYouFilter";
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
        (SEVERITY_RANK[a.entry.severity] ?? 9) -
          (SEVERITY_RANK[b.entry.severity] ?? 9) || a.i - b.i,
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
export function withoutSuggestedAsks(
  items: NeedsYouEntry[],
  suggested?: UseSuggestedTasks,
): NeedsYouEntry[] {
  if (!suggested?.loaded || suggested.error || suggested.items.length === 0)
    return items;
  const shown = new Set(
    suggested.items
      .map((t) => arrivalKeyOf(t.source))
      .filter((k): k is string => k !== null),
  );
  const here = suggested.profile ?? null;
  return items.filter((e) => {
    if (e.source !== "todo" || e.severity === "approval") return true;
    const key = e.context?.arrival_key;
    if (!key || !shown.has(key)) return true;
    const raisedIn = (e.context.profiles ?? [e.context.profile]).filter(
      (p): p is string => !!p,
    );
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
  // Filter + row open-state persist per browser so navigating away and back
  // keeps the same cut of the list.
  const [filterOpen, setFilterOpen] = usePersistentState(
    "aquarium.needsYou.filterOpen",
    false,
    (raw) => raw === "1",
    (v) => (v ? "1" : "0"),
  );
  const [filter, setFilter] = usePersistentState<NeedsYouFilter>(
    "aquarium.needsYou.filter",
    EMPTY_FILTER,
    parseFilter,
    serializeFilter,
  );
  const roster = useViewableRoster();
  const kept = useMemo(
    () => withoutSuggestedAsks(items, suggested),
    [items, suggested],
  );
  const suggestedItems = useMemo(
    () => suggested?.items ?? [],
    [suggested],
  );
  const facets = useMemo(
    () => facetsOf(kept, suggestedItems),
    [kept, suggestedItems],
  );
  // A persisted `who` id whose person no longer has items here would hide in
  // the stored filter but still count toward "Filter ·N" — prune it once the
  // list has loaded.
  useEffect(() => {
    if (!loaded || !filter.who.length) return;
    const present = new Set(facets.who.map((f) => f.id));
    const keptWho = filter.who.filter((id) => present.has(id));
    if (keptWho.length !== filter.who.length) setFilter({ ...filter, who: keptWho });
  }, [loaded, facets, filter, setFilter]);
  const filtered = useMemo(
    () => applyFilter(kept, suggestedItems, filter),
    [kept, suggestedItems, filter],
  );
  const filteredSuggested = useMemo(
    () =>
      suggested
        ? ({ ...suggested, items: filtered.suggested } as UseSuggestedTasks)
        : undefined,
    [suggested, filtered.suggested],
  );
  const sorted = sortBySeverity(filtered.entries);
  const suggestions = filtered.suggested.length;
  const shownCount = loaded
    ? needsYouCount(count, items, suggested, tally)
    : null;
  const details = useDetails(sorted, filteredSuggested, onActed);
  const shown = sorted.length + suggestions;
  const total = kept.length + suggestedItems.length;

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
        trailing={
          loaded && total > 0 ? (
            <FilterToggle
              open={filterOpen}
              active={activeFilterCount(filter)}
              label={t("filter.label")}
              onToggle={() => setFilterOpen(!filterOpen)}
            />
          ) : undefined
        }
      />
      {filterOpen && total > 0 ? (
        <FilterRows
          facets={facets}
          filter={filter}
          onChange={setFilter}
          label={(id) => t(`filter.group.${id}`)}
          whoLabel={(id) =>
            id === "me" || id === "team"
              ? t(`filter.whom.${id}`)
              : (roster?.people.find((p) => p.user_id === id)?.display ?? id)
          }
        />
      ) : null}
      {filterIsActive(filter) ? (
        <p
          data-testid="needs-you-filtered"
          className="flex items-center gap-2 px-3 text-[11px] font-medium leading-[14px] text-[var(--color-muted)]"
        >
          <span>{t("filter.showing", { n: shown, total })}</span>
          <button
            type="button"
            data-action="needs-you-filter-reset"
            data-appmcp-hint="Clears every source and who filter so all items show again"
            onClick={() => setFilter(EMPTY_FILTER)}
            className="text-[var(--color-accent)] hover:underline"
          >
            {t("filter.reset")}
          </button>
        </p>
      ) : null}
      {filteredSuggested ? (
        <SuggestedTasksNeedsYou
          feed={filteredSuggested}
          canStart={canStart}
          onDetails={details.openTask}
        />
      ) : null}
      {!loaded ? (
        stale ? (
          <p className="px-3 text-[12px] leading-[16px] text-[var(--color-muted)]">
            {t("retrying")}
          </p>
        ) : (
          <div
            aria-hidden
            className="flex flex-col gap-2"
            data-testid="needs-you-skeleton"
          >
            <div className="h-[102px] animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
            <div className="h-[102px] animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
          </div>
        )
      ) : sorted.length === 0 && suggestions > 0 ? null : sorted.length ===
        0 ? (
        filterIsActive(filter) ? (
          <p
            data-testid="needs-you-filter-empty"
            className="px-3 py-3 text-center text-[12px] font-medium leading-[16px] text-[var(--color-muted)]"
          >
            {t("filter.empty")}
          </p>
        ) : (
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
        )
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("listLabel")}>
          {sorted.map((entry) => (
            <NeedsYouItem
              key={entry.id}
              entry={entry}
              now={now}
              isNew={newIds.has(entry.id)}
              onActed={onActed}
              onOpen={details.openEntry}
            />
          ))}
        </ul>
      )}
      {details.current ? (
        <NeedsYouDetails
          item={details.current}
          index={details.index}
          total={details.items.length}
          onStep={details.step}
          onClose={details.close}
          now={now}
          canStart={canStart}
          revision={details.revisionOf(details.current)}
          onActed={details.acted}
          onRevise={details.revise}
          onSuggestedRemoved={details.removed}
        />
      ) : null}
    </section>
  );
}

/** The header's filter button: "Filter", or "Filter ·N" while filters are on. */
function FilterToggle({
  open,
  active,
  label,
  onToggle,
}: {
  open: boolean;
  active: number;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-action="needs-you-filter"
      aria-expanded={open}
      onClick={onToggle}
      className="inline-flex min-h-6 items-center gap-1 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[11px] font-medium leading-[14px] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
    >
      <FilterIcon size={12} />
      {active > 0 ? `${label} ·${active}` : label}
    </button>
  );
}

/** One filter chip, the same pattern as the inbox filters. */
function Chip({
  active,
  action,
  onClick,
  children,
}: {
  active: boolean;
  action: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-component="Chip"
      data-action={action}
      data-active={active || undefined}
      data-appmcp-hint={`Toggles the ${action} filter on the Needs-you list`}
      onClick={onClick}
      className={`inline-flex min-h-6 items-center rounded-full border px-2.5 text-[11px] font-medium leading-[14px] ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The expanded filter row: SOURCE chips (one per bucket present, counts
 * included) and WHO chips (Me / Team / each other person whose waits are in
 * the list). Each is a toggle; nothing selected means "all" — the "All"
 * chip clears that row.
 */
function FilterRows({
  facets,
  filter,
  onChange,
  label,
  whoLabel,
}: {
  facets: ReturnType<typeof facetsOf>;
  filter: NeedsYouFilter;
  onChange: (next: NeedsYouFilter) => void;
  label: (group: SourceGroup) => string;
  whoLabel: (id: string) => string;
}) {
  const { t } = useNeedsYouText();
  const toggleGroup = (id: SourceGroup) =>
    onChange({
      ...filter,
      groups: filter.groups.includes(id)
        ? filter.groups.filter((g) => g !== id)
        : [...filter.groups, id],
    });
  const toggleWho = (id: string) =>
    onChange({
      ...filter,
      who: filter.who.includes(id)
        ? filter.who.filter((w) => w !== id)
        : [...filter.who, id],
    });
  const labelClass =
    "w-14 shrink-0 pt-1 text-[10px] font-semibold uppercase leading-[14px] tracking-wide text-[var(--color-muted)]";
  return (
    <div
      data-testid="needs-you-filters"
      className="flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
    >
      <div className="flex items-start gap-1">
        <span className={labelClass}>{t("filter.source")}</span>
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <Chip
            active={filter.groups.length === 0}
            action="filter-source-all"
            onClick={() => onChange({ ...filter, groups: [] })}
          >
            {t("filter.all")}
          </Chip>
          {facets.groups.map((g) => (
            <Chip
              key={g.id}
              active={filter.groups.includes(g.id)}
              action={`filter-source-${g.id}`}
              onClick={() => toggleGroup(g.id)}
            >
              {label(g.id)} ·{g.count}
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex items-start gap-1">
        <span className={labelClass}>{t("filter.who")}</span>
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <Chip
            active={filter.who.length === 0}
            action="filter-who-all"
            onClick={() => onChange({ ...filter, who: [] })}
          >
            {t("filter.all")}
          </Chip>
          {facets.who.map((w) => (
            <Chip
              key={w.id}
              active={filter.who.includes(w.id)}
              action={`filter-who-${w.id === "me" || w.id === "team" ? w.id : "other"}`}
              onClick={() => toggleWho(w.id)}
            >
              {whoLabel(w.id)} ·{w.count}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Which item the Details view shows. Suggested tasks come first, as on the
 * panel. An item that leaves the list stays on screen until the person moves
 * on; a reply sent back for changes is followed to its rewritten draft.
 */
function useDetails(
  entries: NeedsYouEntry[],
  suggested: UseSuggestedTasks | undefined,
  onActed?: (entry: NeedsYouEntry) => void,
) {
  const [open, setOpen] = useState<NeedsYouDetailItem | null>(null);
  const [revisions, setRevisions] = useState<Record<string, DraftRevision>>({});
  const items: NeedsYouDetailItem[] = [
    ...(suggested?.items ?? []).map((task) => ({
      key: `suggested:${task.todo.id}`,
      kind: "suggested" as const,
      task,
    })),
    ...entries.map((entry) => ({
      key: entry.id,
      kind: "entry" as const,
      entry,
    })),
  ];
  const todoOf = (item: NeedsYouDetailItem | null) =>
    item?.kind === "entry" ? (item.entry.context.todo_id ?? null) : null;
  const revisionOf = (item: NeedsYouDetailItem) => {
    const id = todoOf(item);
    return id ? (revisions[id] ?? null) : null;
  };

  let current: NeedsYouDetailItem | null = null;
  if (open) {
    current = items.find((i) => i.key === open.key) ?? null;
    const todoId = todoOf(open);
    if (!current && todoId && revisions[todoId]) {
      current =
        items.find(
          (i) =>
            i.kind === "entry" &&
            i.entry.severity === "approval" &&
            todoOf(i) === todoId,
        ) ?? null;
    }
    current = current ?? open;
  }
  const index = current ? items.findIndex((i) => i.key === current.key) : -1;

  const step = (delta: -1 | 1) => {
    if (items.length === 0) return;
    const next = index < 0 ? 0 : (index + delta + items.length) % items.length;
    setOpen(items[next]);
  };
  const moveOn = () => {
    const rest = items.filter((i) => i.key !== current?.key);
    setOpen(
      rest.length ? rest[Math.min(Math.max(index, 0), rest.length - 1)] : null,
    );
  };

  return {
    items,
    current,
    index,
    step,
    revisionOf,
    close: () => setOpen(null),
    openEntry: (entry: NeedsYouEntry) =>
      setOpen({ key: entry.id, kind: "entry", entry }),
    openTask: (task: NonNullable<UseSuggestedTasks["items"]>[number]) =>
      setOpen({ key: `suggested:${task.todo.id}`, kind: "suggested", task }),
    acted: (entry: NeedsYouEntry) => {
      onActed?.(entry);
      moveOn();
    },
    revise: (entry: NeedsYouEntry, note: string) => {
      const todoId = entry.context.todo_id;
      if (todoId)
        setRevisions((r) => ({
          ...r,
          [todoId]: { note, answeredKey: entry.id },
        }));
      if (current) setOpen(current);
      onActed?.(entry);
    },
    removed: (id: string) => {
      suggested?.remove(id);
      moveOn();
    },
  };
}

/** The server-side suggested-task count for the Needs-you badge. */
export interface SuggestedTally {
  /** Every suggested task the caller has (staged/open, not snoozed). */
  count: number;
}

/** The tally from a Needs-you read, or null when it had none. */
export function tallyOf(needsYou: {
  suggestedCount: number | null;
}): SuggestedTally | null {
  return needsYou.suggestedCount === null
    ? null
    : { count: needsYou.suggestedCount };
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
  // Only the caller's own waits count: others' seen through "Viewing" never do.
  const own = items.filter((e) => !e.foreign);
  if (!tally) {
    const kept = withoutSuggestedAsks(own, suggested);
    return (
      Math.max(count - (own.length - kept.length), kept.length) +
      (suggested?.items.length ?? 0)
    );
  }
  const here = suggested?.profile ?? null;
  const dropped = own.filter((e) => {
    if (e.source !== "todo" || e.severity === "approval") return false;
    if (!e.context?.suggested) return false;
    const raisedIn = (e.context.profiles ?? [e.context.profile]).filter(
      (p): p is string => !!p,
    );
    return !raisedIn.some((p) => p !== here);
  }).length;
  return Math.max(count - dropped, own.length - dropped) + tally.count;
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
    <PanelWith
      feed={feed}
      canStart={canStart}
      suggested={suggested}
      tally={tally}
    />
  ) : (
    <PanelReadingSuggestions feed={feed} canStart={canStart} />
  );
}

function PanelReadingSuggestions({
  feed,
  canStart,
}: {
  feed?: NeedsYouFeed;
  canStart: boolean;
}) {
  return (
    <PanelWith
      feed={feed}
      canStart={canStart}
      suggested={useSuggestedTasks()}
    />
  );
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

function OwnFeed({
  suggested,
  canStart,
}: {
  suggested: UseSuggestedTasks;
  canStart: boolean;
}) {
  const feed = useNeedsYouFeed();
  return (
    <NeedsYouPanelView
      {...feed}
      suggested={suggested}
      canStart={canStart}
      onActed={() => void feed.refresh()}
    />
  );
}
