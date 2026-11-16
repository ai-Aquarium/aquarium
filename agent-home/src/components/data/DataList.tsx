"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Pill } from "@/components/ui/Pill";
import { inputClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { ChevronRightIcon } from "@/components/ui/icons";
import { formatWhen } from "@/components/sites/format";
import { useLocale, useT } from "@/i18n";
import type { DataSource } from "@/types/data";

import {
  HEALTH_TONE,
  SOURCE_GLYPH,
  STATUS_TONE,
  allows,
  filterSources,
  healthOf,
  needsAttention,
  nextStep,
  sourceType,
  type ListFilter,
  type SourceType,
} from "./format";

const FILTERS: ListFilter[] = ["all", "needs", "mine", "shared"];
const TYPES: (SourceType | "all")[] = ["all", "site", "app", "mssql", "mysql", "postgres", "sqlite"];
const GRID = "lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_auto]";

/** Where a row's next step goes. */
export function nextHref(s: DataSource): string {
  const step = nextStep(s);
  if (step === "review") return `/data/${s.id}/review`;
  if (step === "fix") return `/data/${s.id}?tab=source`;
  if (step === "drift" || step === "build") return `/data/${s.id}?tab=dictionary`;
  return `/data/${s.id}`;
}

export function askHref(id: string): string {
  return `/chat?new=1&source=${encodeURIComponent(id)}`;
}

export function TypeBadge({ source }: { source: Pick<DataSource, "kind" | "engine"> }) {
  const t = useT("data");
  const type = sourceType(source);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
      <span aria-hidden>{SOURCE_GLYPH[type]}</span>
      {t(`type.${type}`)}
    </span>
  );
}

export function HealthPill({ source }: { source: DataSource }) {
  const t = useT("data");
  const h = healthOf(source);
  const key = h.state === "ok" && source.kind === "site" ? "okSite" : h.state;
  return <Pill tone={HEALTH_TONE[h.state]}>{t(`health.${key}`)}</Pill>;
}

export function DictionaryPill({ source }: { source: DataSource }) {
  const t = useT("data");
  const status = source.status ?? "not_described";
  if (status === "draft" && !allows(source.access, "manage")) {
    return <Pill tone="success">{t("status.approved", { v: source.approved_version ?? 0 })}</Pill>;
  }
  return (
    <Pill tone={STATUS_TONE[status]}>
      {status === "approved" ? t("status.approved", { v: source.approved_version ?? 0 }) : status === "draft" ? t("list.draftPill", { n: source.draft_changes ?? 0 }) : t(`status.${status}`)}
    </Pill>
  );
}

/** Data: every data source the person can use, with health, dictionary state, owner and access. */
export function DataList({ sources, people, me = "" }: { sources: DataSource[]; people: Record<string, string>; me?: string }) {
  const t = useT("data");
  const locale = useLocale();
  const [filter, setFilter] = useState<ListFilter>("all");
  const [type, setType] = useState<SourceType | "all">("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => filterSources(sources, { filter, type, q, me }), [sources, filter, type, q, me]);
  const counts: Record<ListFilter, number> = {
    all: sources.length,
    needs: sources.filter(needsAttention).length,
    mine: filterSources(sources, { filter: "mine", type: "all", q: "", me }).length,
    shared: filterSources(sources, { filter: "shared", type: "all", q: "", me }).length,
  };

  if (sources.length === 0) {
    return (
      <div data-component="DataList" className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center">
        <p className="font-medium">{t("list.emptyTitle")}</p>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{t("list.emptyBody")}</p>
      </div>
    );
  }
  const owner = (s: DataSource) => (!s.owner_user_id ? t("list.admins") : s.owner_user_id === me ? t("list.you") : (people[s.owner_user_id] ?? s.owner_user_id));
  return (
    <div data-component="DataList" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div role="tablist" aria-label={t("list.filterLabel")} className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`min-h-9 rounded-full border px-3 py-1 text-xs ${
                filter === f
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)]"
              }`}
            >
              {t(`list.filter.${f}`)} <span className="opacity-80">{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-1 gap-2 lg:justify-end">
          <label className="min-w-0 flex-1 lg:max-w-xs">
            <span className="sr-only">{t("list.search")}</span>
            <input className={inputClass} value={q} placeholder={t("list.searchPlaceholder")} onChange={(e) => setQ(e.target.value)} />
          </label>
          <label className="shrink-0">
            <span className="sr-only">{t("list.type")}</span>
            <select className={`${inputClass} w-auto`} value={type} onChange={(e) => setType(e.target.value as SourceType | "all")}>
              {TYPES.map((k) => (
                <option key={k} value={k}>
                  {k === "all" ? t("list.allTypes") : t(`type.${k}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div aria-hidden className={`hidden gap-2 px-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)] lg:grid ${GRID}`}>
        <span>{t("list.col.source")}</span>
        <span>{t("list.col.connection")}</span>
        <span>{t("list.col.dictionary")}</span>
        <span>{t("list.col.who")}</span>
        <span className="w-40" />
      </div>
      {shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">{t("list.noneInFilter")}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {shown.map((s) => {
            const h = healthOf(s);
            const drift = (s.schema_drift?.length ?? 0) > 0;
            return (
              <li key={s.id} data-source={s.id} className={`grid gap-2 px-4 py-3 hover:bg-[var(--color-surface-2)] lg:items-center ${GRID}`}>
                <Link href={`/data/${s.id}`} className="flex min-w-0 items-start gap-3">
                  <span aria-hidden className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-2)] text-[var(--color-accent)]">
                    {SOURCE_GLYPH[sourceType(s)]}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-[var(--color-fg)]">{s.name}</span>
                      <TypeBadge source={s} />
                    </span>
                    <span className="text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                      {t(`kind.${s.kind}`)} · {t("list.described", { n: s.tables_described ?? 0 })}
                    </span>
                  </span>
                </Link>
                <div className="flex flex-wrap items-center gap-1 pl-12 lg:pl-0">
                  <span className="text-xs text-[var(--color-muted)] lg:hidden">{t("list.col.connection")}</span>
                  <HealthPill source={s} />
                  {h.checked_at ? <span className="text-xs text-[var(--color-muted)]">{formatWhen(h.checked_at, locale)}</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-1 pl-12 lg:pl-0">
                  <span className="text-xs text-[var(--color-muted)] lg:hidden">{t("list.col.dictionary")}</span>
                  <DictionaryPill source={s} />
                  {drift ? <Pill tone="warning">{t("status.drift")}</Pill> : null}
                </div>
                <div className="pl-12 text-xs lg:pl-0">
                  <div className="text-[var(--color-muted)]">{t("list.ownerLabel")}</div>
                  <div className="text-[var(--color-fg)]">
                    {owner(s)} · <span className="text-[var(--color-muted)]">{t(`access.${s.access}`)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-12 lg:pl-0">
                  <Link href={askHref(s.id)} className={`${secondaryButtonClass} inline-flex min-h-9 items-center`} aria-label={t("list.askAbout", { name: s.name })}>
                    {t("list.ask")}
                  </Link>
                  <Link href={nextHref(s)} className="inline-flex min-h-9 items-center gap-1 text-sm text-[var(--color-accent)]">
                    {t(`list.next.${nextStep(s)}`, { n: s.draft_changes ?? 0 })}
                    <ChevronRightIcon size={16} />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
