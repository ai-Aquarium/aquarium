"use client";

import { useState } from "react";

import { activityEntries, type ActivityEntry } from "@/components/projects/dashboard/activity";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { useT } from "@/i18n";
import type { ProjectBoardView, ProjectDetail } from "@/types";

export const LOG_FILTERS = ["all", "people", "agents"] as const;

export type LogFilter = (typeof LOG_FILTERS)[number];

/** People are the project's owner and members; every other actor is an agent. */
export function logEntries(
  project: ProjectDetail,
  board: ProjectBoardView | null,
  filter: LogFilter,
): (ActivityEntry & { by: "people" | "agents" })[] {
  const people = new Set([project.owner_user_id, ...project.members.map((m) => m.user_id)]);
  return activityEntries(project, board, 100)
    .map((entry) => ({
      ...entry,
      by: entry.actor && people.has(entry.actor) ? ("people" as const) : ("agents" as const),
    }))
    .filter((entry) => filter === "all" || entry.by === filter);
}

const TONE_DOT: Record<ActivityEntry["tone"], string> = {
  ok: "bg-emerald-400",
  bad: "bg-red-400",
  now: "bg-[var(--color-accent)]",
  change: "bg-amber-400",
  muted: "bg-[var(--color-muted)]",
};

/**
 * The project's Log (PR 1 placeholder): the card events and run starts/ends
 * the project already returns, newest first, filtered by who did them. The
 * full people + agents log (chat turns, plan edits, tool calls) comes with
 * its own API in a later stage.
 */
export function ProjectLog({ project, board }: { project: ProjectDetail; board: ProjectBoardView | null }) {
  const t = useT("projects");
  const timeLabel = useTimeLabel();
  const [filter, setFilter] = useState<LogFilter>("all");
  const entries = logEntries(project, board, filter);
  return (
    <section data-component="ProjectLog" className="flex min-w-0 flex-col gap-3">
      <div role="group" aria-label={t("log.filterAria")} className="flex gap-1">
        {LOG_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            data-filter={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={`h-8 rounded-[var(--radius-full)] border px-3 text-xs ${
              filter === value
                ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]"
                : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            {t(`log.${value}`)}
          </button>
        ))}
      </div>
      {entries.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          {t("log.empty")}
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {entries.map((entry) => (
            <li key={entry.key} data-by={entry.by} className="flex items-start gap-3 px-4 py-2.5 text-sm">
              <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-[var(--radius-full)] ${TONE_DOT[entry.tone]}`} />
              <span className="min-w-0 flex-1">
                {entry.text}
                <span className="block text-xs text-[var(--color-muted)]">
                  {[entry.actor ?? t(entry.by === "people" ? "log.person" : "log.agent"), timeLabel(entry.at, "ago")].join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-[var(--color-muted)]">{t("log.note")}</p>
    </section>
  );
}
