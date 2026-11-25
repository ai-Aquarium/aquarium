import type { NeedsYouEntry } from "@/types/landing";
import type { SuggestedTask } from "@/types";

/**
 * The Needs-you filter model. Every entry lands in exactly one group; a
 * suggested task (a separate feed) is its own group. Chips are built from
 * `facetsOf` — only buckets actually present get one, like IncomingsFilters
 * builds from server facets. Both dimensions are toggles: an empty
 * selection means "all" (never a state that shows nothing by itself).
 */

export type SourceGroup =
  | "suggested"
  | "projects"
  | "approvals"
  | "messages"
  | "data"
  | "other";

export const GROUP_ORDER: SourceGroup[] = [
  "suggested",
  "projects",
  "approvals",
  "messages",
  "data",
  "other",
];

const PROJECT_SOURCES = new Set<string>([
  "project_checkpoint",
  "budget",
  "card_wait",
  "card_approval",
  "card_blocked",
  "output_acceptance",
  "clarify",
  "plan_approval",
]);
const APPROVAL_SOURCES = new Set<string>([
  "chat_tool_approval",
  "webview_approval",
  "source_claim",
]);
const MESSAGE_SOURCES = new Set<string>(["todo", "notification"]);
const DATA_SOURCES = new Set<string>(["data_draft", "data_schema", "data_health"]);

/** Which bucket an entry belongs to. A `project_slug` wins — it's a project wait however it was raised. */
export function sourceGroupOf(entry: Pick<NeedsYouEntry, "source" | "context">): SourceGroup {
  if (entry.context?.project_slug || PROJECT_SOURCES.has(entry.source)) return "projects";
  if (APPROVAL_SOURCES.has(entry.source)) return "approvals";
  if (MESSAGE_SOURCES.has(entry.source)) return "messages";
  if (DATA_SOURCES.has(entry.source)) return "data";
  return "other";
}

/**
 * Whose wait an entry is: "me", "team" (a duty of the caller's role), or an
 * `owner_user_id` (someone else's, view-only — only present when "Viewing"
 * already includes them). Suggested tasks are always "me".
 */
export function whoOf(entry: Pick<NeedsYouEntry, "foreign" | "team" | "owner_user_id">): string {
  if (entry.foreign) return entry.owner_user_id ?? "someone";
  return entry.team ? "team" : "me";
}

export interface NeedsYouFilter {
  /** Selected source groups; empty = all groups. */
  groups: SourceGroup[];
  /** Selected who buckets ("me" | "team" | owner_user_id); empty = all. */
  who: string[];
}

export const EMPTY_FILTER: NeedsYouFilter = { groups: [], who: [] };

const GROUP_IDS = new Set<string>(GROUP_ORDER);

/**
 * localStorage form of a filter (`usePersistentState`): plain JSON. Stale
 * group ids (a renamed bucket) are dropped rather than breaking the panel;
 * a malformed blob falls back to EMPTY so nothing is ever filtered out by
 * accident.
 */
export function parseFilter(raw: string): NeedsYouFilter {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null) return EMPTY_FILTER;
  const { groups, who } = v as { groups?: unknown; who?: unknown };
  return {
    groups: Array.isArray(groups)
      ? groups.filter((g): g is SourceGroup => typeof g === "string" && GROUP_IDS.has(g))
      : [],
    who: Array.isArray(who) ? who.filter((w): w is string => typeof w === "string") : [],
  };
}

export function serializeFilter(filter: NeedsYouFilter): string {
  return JSON.stringify(filter);
}

export function filterIsActive(filter: NeedsYouFilter): boolean {
  return filter.groups.length > 0 || filter.who.length > 0;
}

export function activeFilterCount(filter: NeedsYouFilter): number {
  return filter.groups.length + filter.who.length;
}

export interface NeedsYouFacets {
  /** Buckets present, in `GROUP_ORDER`, with their counts. */
  groups: { id: SourceGroup; count: number }[];
  /** Who buckets present ("me" first, then "team", then other people). */
  who: { id: string; count: number }[];
}

export function facetsOf(items: NeedsYouEntry[], suggested: SuggestedTask[]): NeedsYouFacets {
  const groups = new Map<SourceGroup, number>();
  const who = new Map<string, number>();
  const bump = <K>(map: Map<K, number>, key: K, by = 1) =>
    map.set(key, (map.get(key) ?? 0) + by);
  if (suggested.length) {
    bump(groups, "suggested", suggested.length);
    bump(who, "me", suggested.length);
  }
  for (const entry of items) {
    bump(groups, sourceGroupOf(entry));
    bump(who, whoOf(entry));
  }
  return {
    groups: GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({
      id: g,
      count: groups.get(g) ?? 0,
    })),
    who: [...who.entries()].map(([id, count]) => ({ id, count })),
  };
}

export function applyFilter(
  items: NeedsYouEntry[],
  suggested: SuggestedTask[],
  filter: NeedsYouFilter,
): { entries: NeedsYouEntry[]; suggested: SuggestedTask[] } {
  const groups = filter.groups.length ? new Set(filter.groups) : null;
  const who = filter.who.length ? new Set(filter.who) : null;
  return {
    entries: items.filter(
      (e) =>
        (!groups || groups.has(sourceGroupOf(e))) && (!who || who.has(whoOf(e))),
    ),
    suggested: groups && !groups.has("suggested") ? [] : who && !who.has("me") ? [] : suggested,
  };
}
