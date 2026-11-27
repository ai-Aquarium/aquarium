"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ActionError } from "@/components/projects/ActionError";
import {
  ApprovalDetail,
  OutboundDecision,
  describeOutbound,
  sendFailure,
  type OutboundDecisionKind,
} from "@/components/projects/CardApprovals";
import { ComparePanel } from "@/components/projects/execution/ComparePanel";
import {
  readRun,
  readRunHistory,
  runActionPath,
  runScorePath,
} from "@/components/projects/execution/runData";
import {
  COMPARE_MIN,
  cardSeconds,
  cardState,
  currentRunNo,
  mergeRunHistory,
  toggleCompare,
} from "@/components/projects/execution/runStats";
import {
  CARD,
  RUN_TONE,
  STATE_CLASS,
  StateIcon,
  versionLabel,
} from "@/components/projects/execution/runUi";
import { durationLabel } from "@/components/projects/format";
import { downloadHref } from "@/components/projects/outputs/OpenArtifact";
import { useProjectArtifacts } from "@/components/projects/outputs/useProjectArtifacts";
import { isLiveRun } from "@/components/projects/panels/RunsPanel";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useRunLive } from "@/components/projects/useRunLive";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { useConfirm } from "@/components/ui/useConfirm";
import { useFileRefOpener } from "@/components/files/FileRefOpener";
import { newTabRel } from "@/lib/http/link-rel";
import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n";
import type {
  ProjectArtifact,
  ProjectBoardTask,
  ProjectCardApproval,
  ProjectOutputWithDeliveries,
  ProjectRun,
  ProjectRunBrief,
  ProjectRunCard,
  ProjectRunStatus,
} from "@/types";

const TOOL_BTN =
  "rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50";
const PRIMARY_BTN =
  "rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50";

const STATUS_DOT: Record<ProjectRunStatus, string> = {
  running: "bg-[var(--color-accent)]",
  waiting: "bg-[var(--color-warn)]",
  blocked: "bg-[var(--color-danger)]",
  done: "bg-[var(--color-success)]",
  failed: "bg-[var(--color-danger)]",
  cancelled: "bg-[var(--color-muted)]",
};

function Star({ filled, size = 12 }: { filled?: boolean; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "var(--color-warn-text)" : "none"}
      stroke={filled ? "var(--color-warn-text)" : "var(--color-muted)"}
      strokeWidth={2}
      strokeLinejoin="round"
    >
      <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5L2.5 9.4l6.6-.9z" />
    </svg>
  );
}

/**
 * The Runs step (2026-11-27 redesign, approved mockup): the run list on the
 * left, the selected run on the right — its cards, the approval it is
 * waiting on, the outputs so far and the grade/compare tools. Tick two rows
 * (or "Compare with R<n>") for the side-by-side panel.
 */
export function RunsWorkspace({ project, board, onDiscussInChat }: ProjectTabProps) {
  const t = useT("execution");
  const [history, setHistory] = useState<ProjectRunBrief[]>([]);
  // Re-read the record whenever the polled project read shows a run moved.
  const listKey = project.runs
    .map((r) => `${r.run_no}:${r.status}:${r.score_user ?? ""}`)
    .join(",");
  useEffect(() => {
    let live = true;
    readRunHistory(project.slug).then(
      (next) => {
        if (live) setHistory(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [project.slug, listKey]);
  const runs = useMemo(
    () => mergeRunHistory(history, project.runs),
    [history, project.runs],
  );
  const [picked, setPicked] = useState<number | null>(null);
  const selectedNo = runs.some((r) => r.run_no === picked)
    ? picked
    : currentRunNo(runs);
  const brief = runs.find((r) => r.run_no === selectedNo) ?? null;
  const [ticked, setTicked] = useState<number[]>([]);
  const [comparing, setComparing] = useState<number[] | null>(null);

  const boardTasks = useMemo(() => {
    const map = new Map<string, ProjectBoardTask>();
    for (const column of board?.columns ?? []) {
      for (const task of column.tasks) map.set(task.id, task);
    }
    return map;
  }, [board]);

  return (
    <div data-component="RunsWorkspace" className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
        <RunListRail
          slug={project.slug}
          runs={runs}
          selected={selectedNo}
          ticked={ticked}
          onSelect={setPicked}
          onTick={(n) => setTicked((prev) => toggleCompare(prev, n))}
          onCompare={() => setComparing(ticked)}
        />
        {brief ? (
          <SelectedRun
            key={brief.run_no}
            slug={project.slug}
            brief={brief}
            archived={project.archived}
            outputs={project.outputs}
            boardTasks={boardTasks}
            previousRunNo={
              runs.find((r) => r.run_no < brief.run_no)?.run_no ?? null
            }
            onDiscuss={onDiscussInChat}
            onCompareWith={(prev) => setComparing([prev, brief.run_no])}
          />
        ) : (
          <p className={`${CARD} flex-1 text-sm text-[var(--color-muted)]`}>
            {t("workspace.empty")}
          </p>
        )}
      </div>
      {comparing ? (
        <ComparePanel
          slug={project.slug}
          runNos={comparing}
          onClose={() => setComparing(null)}
          onDiscuss={onDiscussInChat}
        />
      ) : null}
    </div>
  );
}

function RunListRail({
  slug,
  runs,
  selected,
  ticked,
  onSelect,
  onTick,
  onCompare,
}: {
  slug: string;
  runs: ProjectRunBrief[];
  selected: number | null;
  ticked: number[];
  onSelect: (runNo: number) => void;
  onTick: (runNo: number) => void;
  onCompare: () => void;
}) {
  const t = useT("execution");
  const timeLabel = useTimeLabel();
  return (
    <aside
      data-component="RunListRail"
      aria-label={t("workspace.listAria")}
      className="flex max-h-72 w-full shrink-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] lg:max-h-none lg:w-64"
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        <h3 className="flex-1 text-sm font-semibold">{t("table.heading")}</h3>
        <button
          type="button"
          data-appmcp-hint="Compares the ticked runs side by side"
          onClick={onCompare}
          disabled={ticked.length < COMPARE_MIN}
          className="text-xs font-semibold text-[var(--color-accent)] disabled:text-[var(--color-muted)]"
        >
          {t("workspace.compare")}
        </button>
      </div>
      <ul data-component="RunList" className="min-h-0 flex-1 overflow-y-auto">
        {runs.length === 0 ? (
          <li className="p-3 text-xs text-[var(--color-muted)]">
            {t("table.empty")}
          </li>
        ) : (
          runs.map((run) => {
            const on = run.run_no === selected;
            const checked = ticked.includes(run.run_no);
            return (
              <li key={run.run_no}>
                <div
                  data-component="RunListRow"
                  data-selected={on || undefined}
                  className={`flex items-start gap-2 border-b border-[var(--color-border)] px-3 py-2.5 last:border-0 ${
                    on ? "bg-[var(--color-surface-2)]" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    data-appmcp-hint="Ticks this run for comparison"
                    checked={checked}
                    onChange={() => onTick(run.run_no)}
                    aria-label={t("table.select", { n: run.run_no })}
                    className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                  />
                  <button
                    type="button"
                    data-appmcp-hint="Shows this run’s detail"
                    onClick={() => onSelect(run.run_no)}
                    data-run={run.run_no}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold">
                        R{run.run_no}
                      </span>
                      <Pill tone={RUN_TONE[run.status]}>
                        <span
                          aria-hidden
                          className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[run.status]}`}
                        />
                        {t(`status.${run.status}`)}
                      </Pill>
                      {run.score_user != null ? (
                        <span className="ml-auto inline-flex items-center gap-0.5 text-xs font-semibold text-[var(--color-warn-text)]">
                          <Star filled size={11} />
                          {run.score_user.toFixed(1)}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">
                      {run.playbook_rev != null
                        ? `${t("workspace.plan")} ${versionLabel(run.playbook_rev)} · `
                        : ""}
                      {run.trigger}
                      {run.batch_title ? ` · ${run.batch_title}` : ""} ·{" "}
                      {isLiveRun(run.status)
                        ? timeLabel(run.started_at, "ago")
                        : durationLabel(run.duration_seconds)}
                    </span>
                  </button>
                </div>
              </li>
            );
          })
        )}
      </ul>
      {runs.length > 1 ? (
        <p className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] leading-snug text-[var(--color-muted)]">
          {t("workspace.compareHint")}
        </p>
      ) : null}
      {selected != null ? (
        <Link
          href={`/projects/${encodeURIComponent(slug)}/runs/${selected}`}
          className="block border-t border-[var(--color-border)] px-3 py-2 text-xs font-semibold text-[var(--color-accent)]"
        >
          {t("workspace.openRun", { n: selected })} →
        </Link>
      ) : null}
    </aside>
  );
}

function SelectedRun({
  slug,
  brief,
  archived,
  outputs,
  boardTasks,
  previousRunNo,
  onDiscuss,
  onCompareWith,
}: {
  slug: string;
  brief: ProjectRunBrief;
  archived: boolean;
  outputs: ProjectOutputWithDeliveries[];
  boardTasks: Map<string, ProjectBoardTask>;
  previousRunNo: number | null;
  onDiscuss?: (text: string) => void;
  onCompareWith: (previousRunNo: number) => void;
}) {
  const t = useT("execution");
  const timeLabel = useTimeLabel();
  const [run, setRun] = useState<ProjectRun | null>(null);
  const [failed, setFailed] = useState(false);
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
  const cards = useMemo(() => run?.cards ?? [], [run]);
  const doneCount = run
    ? cards.filter((c) => cardState(c, run) === "done").length
    : 0;
  const percent = run?.completion_percent ?? (status === "done" ? 100 : 0);
  const rev = run?.playbook_rev ?? brief.playbook_rev ?? null;

  // A rough "about N min left": the finished cards' average pace over the
  // cards still to go. Shown only once something has actually finished.
  const doneSeconds = cards
    .map(cardSeconds)
    .filter((s): s is number => s != null);
  const remaining = cards.length - doneCount;
  const etaSeconds =
    live && doneSeconds.length > 0 && remaining > 0
      ? Math.round(
          (doneSeconds.reduce((a, b) => a + b, 0) / doneSeconds.length) *
            remaining,
        )
      : null;

  return (
    <section
      data-component="RunDetail"
      className={`${CARD} min-w-0 flex-1`}
      aria-labelledby="run-detail-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="run-detail-heading" className="text-lg font-semibold">
          R{brief.run_no}
        </h3>
        <Pill tone={RUN_TONE[status]}>
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`}
          />
          {t(`status.${status}`)}
        </Pill>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">
          {rev != null ? `${t("workspace.plan")} ${versionLabel(rev)} · ` : ""}
          {t("workspace.started", {
            time: timeLabel(run?.started_at ?? brief.started_at),
          })}
          {run?.cost != null
            ? ` · $${run.cost.toFixed(2)}${live ? ` ${t("workspace.costSoFar")}` : ""}`
            : ""}
        </span>
        {!archived ? (
          <RunActions slug={slug} runNo={brief.run_no} run={run} status={status} />
        ) : null}
      </div>

      <div className="mt-3">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-medium">
            {t("workspace.stepsProgress", {
              done: doneCount,
              total: cards.length,
            })}
          </span>
          {etaSeconds != null ? (
            <span className="text-[var(--color-muted)]">
              {t("workspace.eta", { time: durationLabel(etaSeconds) })}
            </span>
          ) : null}
        </div>
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {failed && !run ? (
        <p className="mt-3 text-sm text-[var(--color-danger)]">
          {t("current.loadFailed")}
        </p>
      ) : !run ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          {t("current.loading")}
        </p>
      ) : cards.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          {t("current.noCards")}
        </p>
      ) : (
        <RunSteps
          slug={slug}
          run={run}
          boardTasks={boardTasks}
          archived={archived}
          onDiscuss={onDiscuss}
        />
      )}

      <RunOutputs slug={slug} runNo={brief.run_no} outputs={outputs} />

      {run && !live ? (
        <RunGrade
          slug={slug}
          run={run}
          archived={archived}
          previousRunNo={previousRunNo}
          onCompareWith={onCompareWith}
          onScored={(score, note) =>
            setRun((prev) =>
              prev
                ? {
                    ...prev,
                    score_user: score,
                    score_note: note ?? prev.score_note,
                  }
                : prev,
            )
          }
        />
      ) : (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          {t("workspace.gradeLater", { n: brief.run_no })}
          {run?.score_self != null
            ? ` · ${t("workspace.selfScore", { score: run.score_self })}`
            : ""}
        </p>
      )}
    </section>
  );
}

/** One row per card, with the approval a waiting card holds under its row. */
function RunSteps({
  slug,
  run,
  boardTasks,
  archived,
  onDiscuss,
}: {
  slug: string;
  run: ProjectRun;
  boardTasks: Map<string, ProjectBoardTask>;
  archived: boolean;
  onDiscuss?: (text: string) => void;
}) {
  const t = useT("execution");
  return (
    <ul className="mt-3 divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
      {(run.cards ?? []).map((card) => {
        const state = cardState(card, run);
        const boardTask = boardTasks.get(card.task_id);
        const seconds = cardSeconds(card);
        return (
          <li key={card.task_id} data-component="RunStep" data-state={state}>
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${STATE_CLASS[state]}`}
              >
                <StateIcon state={state} />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {card.title ?? card.step_key}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--color-muted)]">
                {[
                  boardTask?.assignee ?? null,
                  state === "needs"
                    ? t("workspace.waitingForYou")
                    : seconds != null
                      ? durationLabel(seconds)
                      : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {state === "needs" ? (
              <InlineApproval
                slug={slug}
                card={card}
                boardTask={boardTask}
                run={run}
                archived={archived}
                onDiscuss={onDiscuss}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Continue / Pause / Stop for the selected run (mirrors `RunRowActions`). */
function RunActions({
  slug,
  runNo,
  run,
  status,
}: {
  slug: string;
  runNo: number;
  run: ProjectRun | null;
  status: ProjectRunStatus;
}) {
  const t = useT("execution");
  const { ask, dialog } = useConfirm();
  const action = useProjectAction();
  const [which, setWhich] = useState<string | null>(null);
  if (!isLiveRun(status)) return null;
  const fire = (name: "continue" | "cancel" | "stop") => {
    if (action.busy) return;
    setWhich(name);
    void action.run(runActionPath(slug, runNo, name));
  };
  const pending = (name: string) => action.busy && which === name;
  const canContinue = status === "waiting" || run?.awaiting_continue === true;
  return (
    <div className="flex items-center gap-1.5">
      {dialog}
      {canContinue ? (
        <button
          type="button"
          data-appmcp-hint="Continues this waiting run"
          onClick={() => fire("continue")}
          disabled={action.busy}
          className={PRIMARY_BTN}
        >
          {pending("continue") ? t("workspace.continuing") : t("workspace.continue")}
        </button>
      ) : null}
      <button
        type="button"
        data-appmcp-hint="Pauses this run — no new work is promoted"
        onClick={() => fire("cancel")}
        disabled={action.busy}
        title={t("workspace.pauseTitle")}
        className={TOOL_BTN}
      >
        {pending("cancel") ? t("workspace.pausing") : t("workspace.pause")}
      </button>
      <button
        type="button"
        data-appmcp-hint="Stops this run immediately"
        onClick={async () => {
          const ok = await ask({
            title: t("workspace.stopTitle", { n: runNo }),
            body: t("workspace.stopBody"),
            confirmLabel: t("workspace.stopConfirm"),
          });
          if (ok) fire("stop");
        }}
        disabled={action.busy}
        className={`${TOOL_BTN} text-[var(--color-danger)]`}
      >
        {pending("stop") ? t("workspace.stopping") : t("workspace.stop")}
      </button>
      <ActionError
        action={action}
        className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]"
      />
    </div>
  );
}

/** The approval a waiting card holds open, answered right under its step row. */
function InlineApproval({
  slug,
  card,
  boardTask,
  run,
  archived,
  onDiscuss,
}: {
  slug: string;
  card: ProjectRunCard;
  boardTask: ProjectBoardTask | undefined;
  run: ProjectRun;
  archived: boolean;
  onDiscuss?: (text: string) => void;
}) {
  const t = useT("execution");
  const approvals: ProjectCardApproval[] = boardTask?.pending_approvals ?? [];
  const wait = (run.waiting_on_you ?? []).find(
    (w) => w.task_id === card.task_id,
  );
  const reason =
    wait?.reason ?? (card.last_error || null) ?? approvals[0]?.label ?? null;

  return (
    <div
      data-component="InlineApproval"
      className="mx-3 mb-3 rounded-lg border border-[var(--color-warn)]/45 bg-[var(--color-warn)]/5 p-3"
    >
      <p className="text-xs font-semibold">{t("workspace.approvalNeeded")}</p>
      {reason ? <p className="mt-1 text-sm">{reason}</p> : null}
      {approvals.map((approval) => (
        <InlineApprovalRow
          key={approval.key}
          slug={slug}
          taskId={card.task_id}
          approval={approval}
          archived={archived}
        />
      ))}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Link
          href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(card.task_id)}`}
          data-appmcp-hint="Opens this card’s page"
          className={TOOL_BTN}
        >
          {t("workspace.openCard")}
        </Link>
        {onDiscuss ? (
          <button
            type="button"
            data-appmcp-hint="Asks the agent about this card"
            onClick={() =>
              onDiscuss(
                t("workspace.askAbout", {
                  card: card.title ?? card.step_key ?? card.task_id,
                  run: run.run_no,
                }),
              )
            }
            className={TOOL_BTN}
          >
            {t("workspace.askAgent")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function InlineApprovalRow({
  slug,
  taskId,
  approval,
  archived,
}: {
  slug: string;
  taskId: string;
  approval: ProjectCardApproval;
  archived: boolean;
}) {
  const t = useT("execution");
  const action = useProjectAction<ProjectBoardTask>();
  const [pending, setPending] = useState<OutboundDecisionKind | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const outbound = describeOutbound(approval);
  const decide = (decision: OutboundDecisionKind, note?: string) => {
    if (action.busy) return;
    setPending(decision);
    setFailure(null);
    void action.run(
      `/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/approvals`,
      {
        method: "POST",
        body: note
          ? { key: approval.key, decision, note }
          : { key: approval.key, decision },
        onSuccess: (data) => setFailure(sendFailure(data)),
      },
    );
  };
  return (
    <div className="mt-2" data-appmcp-deny="consent">
      <ApprovalDetail approval={approval} />
      {!archived ? (
        outbound ? (
          <OutboundDecision
            pending={action.busy ? pending : null}
            disabled={action.busy}
            onDecide={decide}
            primaryClass={PRIMARY_BTN}
            buttonClass={TOOL_BTN}
          />
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              data-appmcp-hint="Approves what this card asked for"
              onClick={() => decide("approve")}
              disabled={action.busy}
              className={PRIMARY_BTN}
            >
              {pending === "approve"
                ? t("workspace.approving")
                : t("workspace.approve")}
            </button>
            <button
              type="button"
              data-appmcp-hint="Rejects what this card asked for"
              onClick={() => decide("deny")}
              disabled={action.busy}
              className={TOOL_BTN}
            >
              {pending === "deny"
                ? t("workspace.rejecting")
                : t("workspace.reject")}
            </button>
          </div>
        )
      ) : null}
      {failure ? (
        <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
          {failure}
        </p>
      ) : null}
      <ActionError
        action={action}
        className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]"
      />
    </div>
  );
}

/** Tiles for the files this run produced so far, plus Download all. */
function RunOutputs({
  slug,
  runNo,
  outputs,
}: {
  slug: string;
  runNo: number;
  outputs: ProjectOutputWithDeliveries[];
}) {
  const t = useT("execution");
  const opener = useFileRefOpener();
  const { artifacts, loading } = useProjectArtifacts(slug, outputs);
  const mine = artifacts.filter((a) => a.run_no === runNo);
  const downloadable = mine.filter((f) => downloadHref(f.href) != null);
  const downloadAll = () => {
    for (const file of downloadable) {
      const a = document.createElement("a");
      a.href = downloadHref(file.href) as string;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };
  if (loading && mine.length === 0) return null;
  return (
    <div className="mt-4">
      {opener.dialog}
      <div className="flex items-center gap-2">
        <h4 className="flex-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {t("workspace.outputsHeading")}
        </h4>
        {downloadable.length > 1 ? (
          <button
            type="button"
            data-appmcp-hint="Downloads every file this run produced"
            onClick={downloadAll}
            className="text-xs font-semibold text-[var(--color-accent)]"
          >
            {t("workspace.downloadAll")}
          </button>
        ) : null}
      </div>
      {mine.length === 0 ? (
        <p className="mt-1.5 text-xs text-[var(--color-muted)]">
          {t("workspace.outputsEmpty")}
        </p>
      ) : (
        <ul className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {mine.map((file) => (
            <li key={file.id}>
              <OutputTile
                file={file}
                onOpen={
                  !file.href && file.link_kind === "file" && file.link_ref
                    ? () =>
                        void opener.open({
                          ref: file.link_ref as string,
                          label: file.title,
                        })
                    : undefined
                }
                opening={opener.resolving === file.link_ref}
                goneLabel={t("workspace.outputGone")}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OutputTile({
  file,
  onOpen,
  opening,
  goneLabel,
}: {
  file: ProjectArtifact;
  onOpen?: () => void;
  opening?: boolean;
  goneLabel: string;
}) {
  const inner = (
    <>
      <span className="flex h-8 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-2)] text-[10px] font-bold text-[var(--color-muted)]">
        {(file.ext ?? file.kind ?? "file").toUpperCase().slice(0, 4)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{file.title}</span>
        <span className="block truncate text-[11px] text-[var(--color-muted)]">
          {opening
            ? "Opening…"
            : file.missing
              ? goneLabel
              : (file.output_title ?? file.kind)}
        </span>
      </span>
    </>
  );
  const cls =
    "flex w-full items-center gap-2 rounded-lg border border-[var(--color-border)] p-2 text-left";
  if (file.href) {
    return (
      <a
        data-appmcp-hint="Opens this produced file"
        href={file.href}
        target="_blank"
        rel={newTabRel(file.href)}
        data-component="RunOutputTile"
        className={`${cls} hover:border-[var(--color-accent)]/50`}
      >
        {inner}
      </a>
    );
  }
  if (onOpen) {
    return (
      <button
        type="button"
        data-appmcp-hint="Opens this produced file"
        onClick={onOpen}
        data-component="RunOutputTile"
        className={`${cls} hover:border-[var(--color-accent)]/50`}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      data-component="RunOutputTile"
      data-missing={file.missing || undefined}
      className={`${cls} opacity-70`}
    >
      {inner}
    </span>
  );
}

/** Stars + note + self-score + compare, once the run has finished. */
function RunGrade({
  slug,
  run,
  archived,
  previousRunNo,
  onCompareWith,
  onScored,
}: {
  slug: string;
  run: ProjectRun;
  archived: boolean;
  previousRunNo: number | null;
  onCompareWith: (previousRunNo: number) => void;
  onScored: (score: number, note?: string) => void;
}) {
  const t = useT("execution");
  const action = useProjectAction();
  const [note, setNote] = useState(run.score_note ?? "");
  const [noteOpen, setNoteOpen] = useState(Boolean(run.score_note));
  const [saved, setSaved] = useState(false);
  const save = (score: number, text?: string) => {
    if (action.busy) return;
    setSaved(false);
    void action.run(runScorePath(slug, run.run_no), {
      body: { score, note: (text ?? note).trim() || undefined },
      onSuccess: () => {
        onScored(score, text ?? note);
        setSaved(true);
      },
    });
  };
  return (
    <div
      data-component="RunGrade"
      className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] p-3"
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold">{t("workspace.gradeHeading")}</p>
        <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
          {run.score_self != null
            ? t("workspace.selfScore", { score: run.score_self })
            : t("workspace.noSelfScore")}
        </p>
      </div>
      <div
        role="group"
        aria-label={t("current.scoreAria", { n: run.run_no })}
        className="flex gap-0.5"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            data-appmcp-hint="Grades this run"
            disabled={archived || action.busy}
            aria-pressed={(run.score_user ?? 0) >= n}
            aria-label={`${n}`}
            onClick={() => save(n)}
            className="flex h-8 w-8 items-center justify-center disabled:opacity-50"
          >
            <Star filled={(run.score_user ?? 0) >= n} size={18} />
          </button>
        ))}
      </div>
      <button
        type="button"
        data-appmcp-hint="Adds a note to this run’s grade"
        onClick={() => setNoteOpen((v) => !v)}
        className={TOOL_BTN}
      >
        {noteOpen || run.score_note
          ? t("workspace.note")
          : t("workspace.addNote")}
      </button>
      {previousRunNo != null ? (
        <button
          type="button"
          data-appmcp-hint="Compares this run with the previous one"
          onClick={() => onCompareWith(previousRunNo)}
          className={TOOL_BTN}
        >
          {t("workspace.compareWith", { n: previousRunNo })}
        </button>
      ) : null}
      <span className="text-xs text-[var(--color-muted)]" aria-live="polite">
        {action.busy ? t("current.saving") : saved ? t("current.scoreSaved") : ""}
      </span>
      {noteOpen ? (
        <div className="flex w-full items-end gap-2">
          <textarea
            data-appmcp-hint="Writes a note on this run"
            aria-label={t("workspace.noteAria")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder={t("workspace.notePlaceholder")}
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-transparent p-2 text-sm"
          />
          <button
            type="button"
            data-appmcp-hint="Saves the note with the run’s score"
            disabled={archived || action.busy || run.score_user == null}
            title={run.score_user == null ? t("workspace.gradeFirst") : undefined}
            onClick={() => run.score_user != null && save(run.score_user)}
            className={TOOL_BTN}
          >
            {t("workspace.saveNote")}
          </button>
        </div>
      ) : null}
      {run.score_note && !noteOpen ? (
        <p className="w-full text-sm text-[var(--color-muted)]">
          “{run.score_note}”
        </p>
      ) : null}
      <ActionError
        action={action}
        className="flex w-full flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]"
      />
    </div>
  );
}
