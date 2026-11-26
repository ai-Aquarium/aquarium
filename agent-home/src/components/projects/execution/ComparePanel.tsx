"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { compareRows } from "@/components/projects/execution/runStats";
import { readRun } from "@/components/projects/execution/runData";
import {
  CARD,
  LABEL,
  STATE_CLASS,
  StateIcon,
  versionLabel,
} from "@/components/projects/execution/runUi";
import { durationLabel } from "@/components/projects/format";
import { MessageIcon, XIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import type { ProjectRun } from "@/types";

/**
 * Two–three runs side by side: score, duration, cost, per-step times and
 * each run's retro. Opened from the run list's ticked rows or a run's
 * "Compare with R<n>".
 */
export function ComparePanel({
  slug,
  runNos,
  onClose,
  onDiscuss,
}: {
  slug: string;
  runNos: number[];
  onClose: () => void;
  onDiscuss?: (text: string) => void;
}) {
  const t = useT("execution");
  const key = runNos.join(",");
  const [state, setState] = useState<{ key: string; runs?: ProjectRun[]; failed?: boolean }>({ key });
  useEffect(() => {
    let live = true;
    Promise.all(key.split(",").map((n) => readRun(slug, Number(n)))).then(
      (runs) => {
        if (live) setState({ key, runs });
      },
      () => {
        if (live) setState({ key, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [slug, key]);
  const runs = state.key === key ? state.runs : undefined;
  const rows = useMemo(() => (runs ? compareRows(runs) : []), [runs]);
  const label = runNos.join(", ");
  const cols = {
    gridTemplateColumns: `minmax(4rem, 1.2fr) repeat(${runNos.length}, minmax(5rem, 1fr))`,
  };

  const discuss = () => {
    if (!runs || !onDiscuss) return;
    const lines = runs
      .map((r) =>
        t("compare.line", {
          n: r.run_no,
          rev: r.playbook_rev ?? "—",
          status: t(`status.${r.status}`),
          duration: durationLabel(r.duration_seconds),
          score: r.score_user != null ? `${r.score_user}/5` : "—",
        }),
      )
      .join("\n");
    onDiscuss(t("compare.draft", { runs: label, lines }));
  };

  let body: ReactNode;
  if (state.key === key && state.failed) {
    body = <p className="mt-2 text-sm text-[var(--color-danger)]">{t("compare.loadFailed")}</p>;
  } else if (!runs) {
    body = <p className="mt-2 text-sm text-[var(--color-muted)]">{t("compare.loading")}</p>;
  } else {
    const cell = "px-2 py-2 text-sm";
    body = (
      <div className="mt-2 overflow-x-auto">
        <div
          role="table"
          aria-label={t("compare.heading", { runs: label })}
          className="w-full"
          style={{ minWidth: `${4 + runNos.length * 5}rem` }}
        >
          <div role="row" className="grid border-b border-[var(--color-border)]" style={cols}>
            <span role="columnheader" className={cell} />
            {runs.map((r) => (
              <span role="columnheader" key={r.run_no} className={`${cell} font-semibold`}>
                #{r.run_no}{" "}
                <span className="font-normal text-[var(--color-muted)]">
                  {versionLabel(r.playbook_rev)}
                </span>
              </span>
            ))}
          </div>
          <CompareLine label={t("compare.score")} style={cols}>
            {runs.map((r) => (r.score_user != null ? `${r.score_user}/5` : "—"))}
          </CompareLine>
          <CompareLine label={t("compare.duration")} style={cols}>
            {runs.map((r) => durationLabel(r.duration_seconds))}
          </CompareLine>
          <CompareLine label={t("compare.cost")} style={cols}>
            {runs.map((r) => (r.cost != null ? `$${r.cost.toFixed(2)}` : "—"))}
          </CompareLine>
          <div role="row" className="grid pt-2" style={cols}>
            <span role="rowheader" className={`${LABEL} px-2 py-1`}>
              {t("compare.steps")}
            </span>
          </div>
          {rows.map((row) => (
            <div
              role="row"
              key={row.key}
              data-component="CompareStep"
              className="grid border-b border-[var(--color-border)]"
              style={cols}
            >
              <span
                role="rowheader"
                className={`${cell} truncate max-sm:col-span-full max-sm:pb-0 max-sm:font-medium`}
                title={row.title}
              >
                {row.title}
              </span>
              {row.cells.map((c, i) => (
                <span
                  role="cell"
                  key={i}
                  data-slowest={row.slowest === i || undefined}
                  className={`${cell} flex flex-wrap items-center gap-1 ${i === 0 ? "max-sm:col-start-2" : ""} ${
                    c.state ? STATE_CLASS[c.state] : "text-[var(--color-muted)]"
                  }`}
                >
                  {c.state ? (
                    <>
                      <StateIcon state={c.state} />
                      <span className="tabular-nums">
                        {c.seconds != null ? durationLabel(c.seconds) : t(`state.${c.state}`)}
                      </span>
                      {row.slowest === i ? (
                        <span className="rounded-full bg-[var(--color-warn)]/15 px-1.5 text-[10px] text-[var(--color-warn-text)]">
                          {t("compare.slowest")}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    t("state.none")
                  )}
                </span>
              ))}
            </div>
          ))}
          <div role="row" className="grid" style={cols}>
            <span role="rowheader" className={`${LABEL} px-2 py-2`}>
              {t("compare.retro")}
            </span>
            {runs.map((r) => (
              <span role="cell" key={r.run_no} className="px-2 py-2 text-xs text-[var(--color-muted)]">
                <span className="line-clamp-4">{r.retro || r.summary || t("compare.noRetro")}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section data-component="ComparePanel" className={CARD} aria-labelledby="compare-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="compare-heading" className={LABEL}>
          {t("compare.heading", { runs: label })}
        </h3>
        <div className="ml-auto flex items-center gap-1">
          {onDiscuss ? (
            <button
              type="button"
              data-appmcp-hint="Asks the agent to compare these runs in chat"
              onClick={discuss}
              disabled={!runs}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-[var(--color-border)] px-3 text-sm disabled:opacity-50"
            >
              <MessageIcon size={16} aria-hidden />
              {t("compare.discuss")}
            </button>
          ) : null}
          <button
            type="button"
            data-appmcp-hint="Closes this comparison"
            onClick={onClose}
            aria-label={t("compare.close")}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-[var(--color-surface-2)]"
          >
            <XIcon size={16} aria-hidden />
          </button>
        </div>
      </div>
      {body}
    </section>
  );
}

function CompareLine({
  label,
  style,
  children,
}: {
  label: string;
  style: { gridTemplateColumns: string };
  children: ReactNode[];
}) {
  return (
    <div role="row" className="grid border-b border-[var(--color-border)]" style={style}>
      <span role="rowheader" className="px-2 py-2 text-sm text-[var(--color-muted)]">
        {label}
      </span>
      {children.map((value, i) => (
        <span role="cell" key={i} className="px-2 py-2 text-sm tabular-nums">
          {value}
        </span>
      ))}
    </div>
  );
}
