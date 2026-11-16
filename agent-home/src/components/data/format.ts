/** Pure helpers for the Data pages (data dictionary, plan 2026-11-14-001). */
import type { Tone } from "@/components/ui/Pill";
import type { DataAccess, DataEngine, DataSource, DataSourceHealth, DictionaryEntries, DictionaryEntry, DictionaryStatus } from "@/types/data";

export const STATUS_TONE: Record<DictionaryStatus, Tone> = {
  approved: "success",
  draft: "warning",
  not_described: "muted",
};

const RANK: Record<DataAccess, number> = { read: 1, propose: 2, manage: 3 };

export function allows(access: DataAccess | undefined, need: DataAccess): boolean {
  return !!access && RANK[access] >= RANK[need];
}

export function dataPath(id: string, ...parts: string[]): string {
  return ["/api/data/sources", encodeURIComponent(id), ...parts.map(encodeURIComponent)].join("/");
}

export const EMPTY_ENTRY: DictionaryEntry = {
  meaning: "",
  row: "",
  grain: "",
  columns: {},
  joins: [],
  metrics: [],
  examples: [],
};

export function entryOf(entries: DictionaryEntries | null | undefined, table: string): DictionaryEntry {
  return { ...EMPTY_ENTRY, ...(entries?.tables?.[table] ?? {}) };
}

/** `name: text` lines <-> the columns map (blank lines and lines without a name are dropped). */
export function columnsToText(columns: Record<string, string>): string {
  return Object.entries(columns)
    .map(([c, d]) => `${c}: ${d}`)
    .join("\n");
}

export function textToColumns(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    const name = (at < 0 ? line : line.slice(0, at)).trim().toLowerCase();
    if (name) out[name] = at < 0 ? "" : line.slice(at + 1).trim();
  }
  return out;
}

/** What a reviewer sees changed in one table, field by field. */
export function fieldDiff(before: DictionaryEntry | null, after: DictionaryEntry | null): { field: string; from: string; to: string }[] {
  const show = (e: DictionaryEntry | null, f: keyof DictionaryEntry): string => {
    if (!e) return "";
    const v = e[f];
    if (typeof v === "string") return v;
    if (f === "columns") return columnsToText(v as Record<string, string>);
    return (v as Record<string, string>[]).map((i) => Object.values(i).filter(Boolean).join(" — ")).join("\n");
  };
  const fields: (keyof DictionaryEntry)[] = ["meaning", "row", "grain", "columns", "joins", "metrics", "examples"];
  return fields.flatMap((f) => {
    const from = show(before, f);
    const to = show(after, f);
    return from === to ? [] : [{ field: f, from, to }];
  });
}

/** The engine label key for a source: its own kind, or its database engine for a connection. */
export type SourceType = "app" | "site" | DataEngine;

export function sourceType(s: Pick<DataSource, "kind" | "engine">): SourceType {
  return s.kind === "connection" ? (s.engine ?? "mssql") : s.kind;
}

export const SOURCE_GLYPH: Record<SourceType, string> = {
  app: "◉",
  site: "▥",
  mssql: "▣",
  mysql: "◧",
  postgres: "◨",
  sqlite: "▤",
};

export const HEALTH_TONE: Record<DataSourceHealth["state"], Tone> = {
  ok: "success",
  attention: "danger",
  untested: "muted",
  builtin: "success",
};

/** Built-in app data always works; a source without a check yet is "untested". */
export function healthOf(s: DataSource): DataSourceHealth {
  if (s.health) return s.health;
  return s.kind === "app" ? { state: "builtin" } : { state: "untested" };
}

/** A site's health from its last refresh run. */
export function siteHealth(run: { status: string; started_at?: string | null; error?: string | null } | null): DataSourceHealth {
  if (!run) return { state: "untested" };
  if (run.status === "error") return { state: "attention", checked_at: run.started_at ?? null, detail: run.error ?? null };
  return { state: "ok", checked_at: run.started_at ?? null };
}

/** What the person can usefully do next, as a message key under `list.next`. */
export function nextStep(s: DataSource): string {
  const manage = allows(s.access, "manage");
  if (!manage) return s.status === "not_described" && allows(s.access, "propose") ? "build" : "open";
  if (healthOf(s).state === "attention") return "fix";
  if ((s.schema_drift?.length ?? 0) > 0) return "drift";
  if (s.status === "draft") return "review";
  if (s.status === "not_described") return "build";
  return "open";
}

/** Whether a source is waiting on the person (they manage it and something is off). */
export function needsAttention(s: DataSource): boolean {
  return allows(s.access, "manage") && nextStep(s) !== "open";
}

export type ListFilter = "all" | "needs" | "mine" | "shared";

export function filterSources(
  sources: DataSource[],
  { filter, type, q, me }: { filter: ListFilter; type: SourceType | "all"; q: string; me: string },
): DataSource[] {
  const needle = q.trim().toLowerCase();
  return sources.filter(
    (s) =>
      (filter === "all" ||
        (filter === "needs" && needsAttention(s)) ||
        (filter === "mine" && s.owner_user_id === me) ||
        (filter === "shared" && s.owner_user_id !== me && s.access !== "manage")) &&
      (type === "all" || sourceType(s) === type) &&
      (!needle || `${s.name} ${s.connection ?? ""}`.toLowerCase().includes(needle)),
  );
}

/** Schemas named in dotted table names (`sales.orders` → `sales`), most tables first. */
export function schemasOf(tables: string[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tables) {
    const at = t.indexOf(".");
    if (at > 0) counts.set(t.slice(0, at), (counts.get(t.slice(0, at)) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Tables whose name, meaning or column text contains every word of `q`. */
export function searchEntries(entries: DictionaryEntries | null | undefined, q: string): string[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tables = entries?.tables ?? {};
  return Object.keys(tables)
    .filter((name) => {
      const e = tables[name];
      const hay = [name, e.meaning, e.row, e.grain, ...Object.entries(e.columns ?? {}).flat()].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort();
}

export const DATA_TABS = ["overview", "dictionary", "access", "history", "source"] as const;
export type DataTab = (typeof DATA_TABS)[number];

export function isDataTab(x: unknown): x is DataTab {
  return typeof x === "string" && (DATA_TABS as readonly string[]).includes(x);
}

