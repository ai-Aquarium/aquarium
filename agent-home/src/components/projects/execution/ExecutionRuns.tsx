"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ActionError } from "@/components/projects/ActionError";
import {
  COMPARE_MAX,
  COMPARE_MIN,
  cardState,
  compareRows,
  currentRunNo,
  scoreTrend,
  toggleCompare,
  type CardState,
} from "@/components/projects/execution/runStats";
import { durationLabel } from "@/components/projects/format";
import { RunRowActions, isLiveRun } from "@/components/projects/panels/RunsPanel";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useRunLive } from "@/components/projects/useRunLive";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import {
  AlertIcon,
  ArrowRightIcon,
  CheckIcon,
  ClockIcon,
  LoaderIcon,
  MessageIcon,
  XIcon,
} from "@/components/ui/icons";
import { Pill, type Tone } from "@/components/ui/Pill";
import { useT } from "@/i18n";
import type { ProjectRun, ProjectRunBrief, ProjectRunStatus } from "@/types";

const CARD =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const LABEL = "text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]";

const RUN_TONE: Record<ProjectRunStatus, Tone> = {
  running: "accent",
  waiting: "warning",
  blocked: "danger",
  done: "success",
  failed: "danger",
  cancelled: "muted",
};

const STATE_CLASS: Record<CardState, string> = {
  done: "text-[var(--color-success)]",
  running: "text-[var(--color-accent)]",
  needs: "text-[var(--color-warn-text)]",
  todo: "text-[var(--color-muted)]",
  skipped: "text-[var(--color-muted)]",
};

function StateIcon({ state }: { state: CardState }) {
  if (state === "done") return <CheckIcon size={14} aria-hidden />;
  if (state === "running") return <LoaderIcon size={14} aria-hidden />;
  if (state === "needs") return <AlertIcon size={14} aria-hidden />;
  return <ClockIcon size={14} aria-hidden />;
}

function runPath(slug: string, runNo: number): string {
  return `/api/projects/${encodeURIComponent(slug)}/runs/${runNo}`;
}

async function readRun(slug: string, runNo: number): Promise<ProjectRun> {
  const res = await fetch(runPath(slug, runNo), { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as ProjectRun;
}

function versionLabel(rev: number | null | undefined): string {
  return rev != null ? `v${rev}` : "—";
}

/**
 * Execution (2026-11-22 redesign, mockup 2e–2h): the run on now with each
 * card's state, every run as a table (version, status, duration, the human
 * 1–5 score), the score trend, and 2–3 runs side by side.
 */
export function ExecutionRuns({ project, onDiscussInChat }: ProjectTabProps) {
  const runs = useMemo(
    () => [...project.runs].sort((a, b) => b.run_no - a.run_no),
    [project.runs],
  );
  const current = currentRunNo(runs);
  const brief = runs.find((r) => r.run_no === current) ?? null;
  const [selected, setSelected] = useState<number[]>([]);
  const [comparing, setComparing] = useState<number[] | null>(null);

  return (
    <div data-component="ExecutionRuns" className="flex min-w-0 flex-col gap-4">
      {brief ? (
        <CurrentRun
          key={brief.run_no}
          slug={project.slug}
          brief={brief}
          archived={project.archived}
        />
      ) : null}
      {comparing ? (
        <ComparePanel
          slug={project.slug}
          runNos={comparing}
          onClose={() => setComparing(null)}
          onDiscuss={onDiscussInChat}
        />
      ) : null}
      <RunsTable
        slug={project.slug}
        runs={runs}
        selected={selected}
        onToggle={(n) => setSelected((prev) => toggleCompare(prev, n))}
        onCompare={() => setComparing(selected)}
      />
      {runs.length > 0 ? <ScoreTrend runs={runs} /> : null}
    </div>
  );
}

function CurrentRun({
  slug,
  brief,
  archived,
}: {
  slug: string;
  brief: ProjectRunBrief;
  archived: boolean;
}) {
  const t = useT("execution");
  const [run, setRun] = useState<ProjectRun | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-read when the list says the run moved on (the page poller refreshes it).
  useEffect(() => {
    let live = true;
    readRun(slug, brief.run_no).then(
      (next) => {
        if (live) setRun(next);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [slug, brief.run_no, brief.status, brief.score_user]);
  const status = run?.status ?? brief.status;
  const hasActiveCard = (run?.cards ?? []).some((c) => c.status === "running");
  useRunLive(slug, brief.run_no, status, setRun, hasActiveCard);
  const live = isLiveRun(status);
  const percent = run?.completion_percent ?? (status === "done" ? 100 : 0);
  const rev = run?.playbook_rev ?? brief.playbook_rev ?? null;

  return (
    <section data-component="CurrentRun" className={CARD} aria-labelledby="current-run-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="current-run-heading" className={LABEL}>
          {t("current.heading")}
        </h3>
        <span className="text-sm font-semibold">{t("current.run", { n: brief.run_no })}</span>
        {rev != null ? (
          <span className="text-xs text-[var(--color-muted)]">
            {t("current.version", { rev })}
          </span>
        ) : null}
        <Pill tone={RUN_TONE[status]}>{t(`status.${status}`)}</Pill>
        <span className="ml-auto text-xs text-[var(--color-muted)]">
          {durationLabel(run?.duration_seconds ?? brief.duration_seconds)}
        </span>
      </div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t("current.progress", { n: percent })}
      >
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      {failed && !run ? (
        <p className="mt-3 text-sm text-[var(--color-danger)]">{t("current.loadFailed")}</p>
      ) : !run ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">{t("current.loading")}</p>
      ) : (run.cards ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">{t("current.noCards")}</p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {(run.cards ?? []).map((card) => {
            const state = cardState(card, run);
            return (
              <li
                key={card.task_id}
                data-component="CurrentRunCard"
                data-state={state}
                className="flex min-h-11 items-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{card.title ?? card.step_key}</span>
                <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${STATE_CLASS[state]}`}>
                  <StateIcon state={state} />
                  {t(`state.${state}`)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {live && !archived ? (
          <div className="-mx-3 -mb-2 flex-1">
            <RunRowActions slug={slug} runNo={brief.run_no} status={status} large />
          </div>
        ) : null}
        <Link
          href={`/projects/${encodeURIComponent(slug)}/runs/${brief.run_no}`}
          className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-sm font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
        >
          {t("current.open")}
          <ArrowRightIcon size={14} aria-hidden />
        </Link>
      </div>
      {run && !live ? (
        <RunScoreRow
          slug={slug}
          run={run}
          archived={archived}
          onScored={(score) => setRun((prev) => (prev ? { ...prev, score_user: score } : prev))}
        />
      ) : null}
    </section>
  );
}

function RunScoreRow({
  slug,
  run,
  archived,
  onScored,
}: {
  slug: string;
  run: ProjectRun;
  archived: boolean;
  onScored: (score: number) => void;
}) {
  const t = useT("execution");
  const action = useProjectAction();
  const [saved, setSaved] = useState(false);
  const save = (score: number) => {
    setSaved(false);
    void action.run(`${runPath(slug, run.run_no)}/score`, {
      body: { score },
      onSuccess: () => {
        onScored(score);
        setSaved(true);
      },
    });
  };
  return (
    <div data-component="CurrentRunScore" className="mt-3 border-t border-[var(--color-border)] pt-3">
      {run.retro ? (
        <p className="mb-3 text-sm">
          <span className={`${LABEL} mr-2`}>{t("current.retro")}</span>
          {run.retro}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className={LABEL}>{t("current.score")}</span>
        <div role="group" aria-label={t("current.scoreAria", { n: run.run_no })} className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              disabled={archived || action.busy}
              aria-pressed={run.score_user === n}
              onClick={() => save(n)}
              className={`h-11 w-11 rounded-xl border text-sm disabled:opacity-50 ${
                run.score_user === n
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] font-medium text-[var(--color-accent-fg)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--color-muted)]" aria-live="polite">
          {action.busy ? t("current.saving") : saved ? t("current.scoreSaved") : ""}
        </span>
      </div>
      <ActionError action={action} />
    </div>
  );
}

function RunsTable({
  slug,
  runs,
  selected,
  onToggle,
  onCompare,
}: {
  slug: string;
  runs: ProjectRunBrief[];
  selected: number[];
  onToggle: (runNo: number) => void;
  onCompare: () => void;
}) {
  const t = useT("execution");
  const timeLabel = useTimeLabel();
  const full = selected.length >= COMPARE_MAX;
  const th = "px-1.5 py-2 sm:px-2 text-left text-xs font-medium text-[var(--color-muted)]";
  return (
    <section data-component="RunsTable" className={CARD} aria-labelledby="runs-table-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="runs-table-heading" className={LABEL}>
          {t("table.heading")}
        </h3>
        {runs.length > 1 ? (
          <span className="text-xs text-[var(--color-muted)]">
            {full ? t("table.max") : t("table.pick")}
          </span>
        ) : null}
        {runs.length > 1 ? (
          <button
            type="button"
            onClick={onCompare}
            disabled={selected.length < COMPARE_MIN}
            className="ml-auto min-h-11 rounded-xl bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
          >
            {t("table.compare", { n: Math.max(selected.length, COMPARE_MIN) })}
          </button>
        ) : null}
      </div>
      {runs.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">{t("table.empty")}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className={`${th} w-11`}>
                  <span className="sr-only">{t("table.compareCol")}</span>
                </th>
                <th className={th}>{t("table.run")}</th>
                <th className={`${th} max-sm:hidden`}>{t("table.version")}</th>
                <th className={`${th} max-sm:hidden`}>{t("table.started")}</th>
                <th className={th}>{t("table.duration")}</th>
                <th className={th}>{t("table.status")}</th>
                <th className={`${th} text-right`}>{t("table.score")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const checked = selected.includes(run.run_no);
                return (
                  <tr
                    key={run.run_no}
                    data-component="RunsTableRow"
                    data-selected={checked || undefined}
                    className={`border-b border-[var(--color-border)] last:border-0 ${
                      checked ? "bg-[var(--color-surface-2)]" : ""
                    }`}
                  >
                    <td className="px-0 py-0">
                      <label className="flex h-11 w-11 cursor-pointer items-center justify-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--color-accent)]"
                          checked={checked}
                          disabled={!checked && full}
                          onChange={() => onToggle(run.run_no)}
                          aria-label={t("table.select", { n: run.run_no })}
                        />
                      </label>
                    </td>
                    <td className="px-1.5 py-1 sm:px-2">
                      <Link
                        href={`/projects/${encodeURIComponent(slug)}/runs/${run.run_no}`}
                        className="inline-flex min-h-11 items-center font-medium text-[var(--color-accent)]"
                      >
                        #{run.run_no}
                      </Link>
                      <span className="ml-1 text-xs text-[var(--color-muted)] sm:hidden">
                        {versionLabel(run.playbook_rev)}
                      </span>
                    </td>
                    <td className="px-1.5 py-1 sm:px-2 text-[var(--color-muted)] max-sm:hidden">
                      {versionLabel(run.playbook_rev)}
                    </td>
                    <td className="px-1.5 py-1 sm:px-2 text-[var(--color-muted)] max-sm:hidden">
                      {timeLabel(run.started_at)}
                    </td>
                    <td className="px-1.5 py-1 sm:px-2 tabular-nums">{durationLabel(run.duration_seconds)}</td>
                    <td className="px-1.5 py-1 sm:px-2">
                      <Pill tone={RUN_TONE[run.status]}>{t(`status.${run.status}`)}</Pill>
                    </td>
                    <td className="px-1.5 py-1 sm:px-2 text-right tabular-nums">
                      {run.score_user != null ? `${run.score_user}/5` : t("table.unscored")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ScoreTrend({ runs }: { runs: ProjectRunBrief[] }) {
  const t = useT("execution");
  const { points, byRev } = useMemo(() => scoreTrend(runs), [runs]);
  const w = Math.max(points.length * 28, 120);
  const h = 72;
  const y = (score: number) => h - 12 - ((score - 1) / 4) * (h - 24);
  const x = (i: number) => 14 + i * 28;
  return (
    <section data-component="ScoreTrend" className={CARD} aria-labelledby="score-trend-heading">
      <h3 id="score-trend-heading" className={LABEL}>
        {t("trend.heading")}
      </h3>
      {points.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">{t("trend.empty")}</p>
      ) : (
        <>
          <div className="mt-2 overflow-x-auto">
            <svg
              role="img"
              aria-label={t("trend.aria")}
              viewBox={`0 0 ${w} ${h + 14}`}
              width={w}
              height={h + 14}
              className="block text-[var(--color-accent)]"
            >
              {[1, 3, 5].map((s) => (
                <line
                  key={s}
                  x1={0}
                  x2={w}
                  y1={y(s)}
                  y2={y(s)}
                  stroke="var(--color-border)"
                  strokeDasharray="2 3"
                />
              ))}
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                points={points.map((p, i) => `${x(i)},${y(p.score)}`).join(" ")}
              />
              {points.map((p, i) => (
                <g key={p.run_no}>
                  <circle cx={x(i)} cy={y(p.score)} r={3.5} fill="currentColor">
                    <title>{`#${p.run_no} · ${p.score}/5`}</title>
                  </circle>
                  <text
                    x={x(i)}
                    y={h + 10}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--color-muted)"
                  >
                    {p.run_no}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
            {byRev.map((r) => (
              <li key={String(r.rev)} data-component="ScoreTrendRev">
                {r.rev != null
                  ? t("trend.avg", { rev: r.rev, avg: r.average, count: r.count })
                  : t("trend.avgNoRev", { avg: r.average, count: r.count })}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ComparePanel({
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
