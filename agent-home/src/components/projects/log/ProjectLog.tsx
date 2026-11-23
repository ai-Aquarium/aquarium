"use client";

import { useCallback, useEffect, useState } from "react";

import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { useT } from "@/i18n";
import type { ProjectDetail, ProjectLogEntry, ProjectLogResponse } from "@/types";

export const LOG_FILTERS = ["all", "people", "agents"] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];

/** The kind chips the mockup shows; `settings` rows only appear under All. */
export const LOG_KINDS = ["playbook", "runs", "tools", "outputs", "inputs"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

const PAGE = 50;

/** Where a row points: its run page or its card page, else nowhere. */
export function logHref(slug: string, entry: ProjectLogEntry): string | null {
  const base = `/projects/${encodeURIComponent(slug)}`;
  if (entry.link?.type === "run") return `${base}/runs/${entry.link.run_no}`;
  if (entry.link?.type === "card") return `${base}/cards/${encodeURIComponent(entry.link.id)}`;
  return null;
}

/** The interpolation values for a row's sentence (lists joined, gaps blank). */
export function logParams(entry: ProjectLogEntry): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(entry.detail)) {
    if (value == null) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** The query for one page of the Log. */
export function logQuery(filter: LogFilter, kind: LogKind | null, cursor: string | null): string {
  const q = new URLSearchParams({ actor: filter, limit: String(PAGE) });
  if (kind) q.set("kind", kind);
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

/** A row's clock time; rows only exist after the client fetch, so no SSR mismatch. */
function clockLabel(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ICON: Record<ProjectLogEntry["kind"], string> = {
  playbook: "M4 4h12v16H4z M8 8h4 M8 12h4 M16 8l4 4-4 4",
  runs: "M7 5l12 7-12 7z",
  tools: "M14 6a4 4 0 0 0-5 5L4 16l4 4 5-5a4 4 0 0 0 5-5l-3 3-3-1-1-3z",
  outputs: "M12 3v12 M7 10l5 5 5-5 M5 21h14",
  inputs: "M12 21V9 M7 14l5-5 5 5 M5 3h14",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v3 M12 19v3 M2 12h3 M19 12h3",
};

function KindIcon({ kind }: { kind: ProjectLogEntry["kind"] }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON[kind] ?? ICON.settings} />
    </svg>
  );
}

const CHIP =
  "min-h-11 rounded-[var(--radius-full)] border px-3 text-xs whitespace-nowrap";
const CHIP_ON =
  "border-[var(--color-accent)] bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]";
const CHIP_OFF =
  "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]";

/**
 * The project's Log: who did what — people and agents — newest first, from
 * `GET /api/projects/{slug}/log`. Filter by who (All / People / Agents) and
 * by what (playbook, runs, tools, outputs, inputs); older pages load on
 * demand. Each row links to its run or card when it has one.
 */
export function ProjectLog({ project }: { project: ProjectDetail }) {
  const t = useT("projects");
  const timeLabel = useTimeLabel();
  const [filter, setFilter] = useState<LogFilter>("all");
  const [kind, setKind] = useState<LogKind | null>(null);
  const [entries, setEntries] = useState<ProjectLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const slug = project.slug;

  const fetchPage = useCallback(
    async (from: string | null, signal?: AbortSignal): Promise<ProjectLogResponse> => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/log?${logQuery(filter, kind, from)}`,
        { signal },
      );
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as ProjectLogResponse;
    },
    [slug, filter, kind],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    fetchPage(null, ctrl.signal).then(
      (page) => {
        setEntries(page.entries);
        setCursor(page.next_cursor);
        setLoading(false);
      },
      () => {
        if (ctrl.signal.aborted) return;
        setError(true);
        setLoading(false);
      },
    );
    return () => ctrl.abort();
  }, [fetchPage]);

  const refilter = (apply: () => void) => {
    apply();
    setLoading(true);
    setError(false);
  };

  const loadOlder = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await fetchPage(cursor);
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.next_cursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const days = entries.map((entry) => timeLabel(entry.at, "day"));
  return (
    <section data-component="ProjectLog" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <div role="group" aria-label={t("log.filterAria")} className="flex gap-1">
          {LOG_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              data-filter={value}
              aria-pressed={filter === value}
              onClick={() => {
                if (filter !== value) refilter(() => setFilter(value));
              }}
              className={`${CHIP} ${filter === value ? CHIP_ON : CHIP_OFF}`}
            >
              {t(`log.${value}`)}
            </button>
          ))}
        </div>
        <span aria-hidden className="mx-1 h-5 w-px bg-[var(--color-border)]" />
        <div role="group" aria-label={t("log.kindAria")} className="flex flex-wrap gap-1">
          {LOG_KINDS.map((value) => (
            <button
              key={value}
              type="button"
              data-kind={value}
              aria-pressed={kind === value}
              onClick={() => refilter(() => setKind((cur) => (cur === value ? null : value)))}
              className={`${CHIP} inline-flex items-center gap-1.5 ${kind === value ? CHIP_ON : CHIP_OFF}`}
            >
              <KindIcon kind={value} />
              {t(`log.kinds.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          {t("log.error")}
        </p>
      ) : entries.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          {loading ? t("log.loading") : t("log.empty")}
        </p>
      ) : (
        <ol className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {entries.map((entry, i) => {
            const day = days[i];
            const header = i === 0 || day !== days[i - 1];
            const href = logHref(slug, entry);
            const who =
              entry.who ?? (entry.actor === "person" ? t("log.someone") : t("log.system"));
            const text = t(`log.action.${entry.action}`, logParams(entry));
            return (
              <li key={entry.id} data-actor={entry.actor} data-kind={entry.kind}>
                {header ? (
                  <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-1.5 text-xs font-semibold text-[var(--color-muted)]">
                    {day}
                  </div>
                ) : null}
                <div className="flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-sm last:border-b-0">
                  <span className="mt-0.5 text-[var(--color-muted)]">
                    <KindIcon kind={entry.kind} />
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    <span className="font-semibold">{who}</span>
                    {entry.actor === "agent" ? (
                      <span className="ml-1.5 rounded-[var(--radius-full)] border border-[var(--color-border)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
                        {t("log.agent")}
                      </span>
                    ) : null}{" "}
                    {href ? (
                      <a href={href} className="text-[var(--color-fg)] underline-offset-2 hover:underline">
                        {text}
                      </a>
                    ) : (
                      text
                    )}
                  </span>
                  <time
                    dateTime={new Date(entry.at * 1000).toISOString()}
                    title={timeLabel(entry.at, "dateTime")}
                    className="shrink-0 text-xs text-[var(--color-muted)]"
                  >
                    {clockLabel(entry.at)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {cursor && !error ? (
        <button
          type="button"
          data-action="log-older"
          disabled={loading}
          onClick={() => void loadOlder()}
          className={`${CHIP} self-center ${CHIP_OFF}`}
        >
          {loading ? t("log.loading") : t("log.older")}
        </button>
      ) : null}
    </section>
  );
}
