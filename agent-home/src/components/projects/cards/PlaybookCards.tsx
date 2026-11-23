"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { UserIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import type { PlaybookRev, PlaybookStep, ProjectPlaybookResponse, ProjectRun } from "@/types";

import { revisionState } from "@/components/projects/playbook/revisions";

import { StepEditSheet } from "./StepEditSheet";
import {
  NODE_H,
  NODE_W,
  PLAN_LANES,
  RUN_LANES,
  cardsRev,
  graphLayout,
  planLane,
  runLane,
  runLanesForSteps,
  stepDeps,
  stepLevels,
  type CardsView,
  type LanesBy,
  type RunLane,
} from "./stepCards";
import type { StepChange } from "@/components/projects/playbook/draftDiff";

/* Inline icons for the view switch (no shared equivalents yet). */
const svg = (children: ReactNode) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const VIEW_ICON: Record<CardsView, ReactNode> = {
  text: svg(<path d="M4 6h16M4 12h16M4 18h10" />),
  kanban: svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </>,
  ),
  graph: svg(
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M8.5 6.8 15.6 11M8.5 17.2l7.1-4.2" />
    </>,
  ),
};

/** Text | Kanban | Graph — how the Plan shows its steps. */
export function PlaybookViewSwitch({
  view,
  onChange,
}: {
  view: CardsView;
  onChange: (view: CardsView) => void;
}) {
  const t = useT("playbookCards");
  return (
    <div
      role="group"
      aria-label={t("view.aria")}
      data-component="PlaybookViewSwitch"
      className="inline-flex overflow-hidden rounded-lg border border-[var(--color-border)]"
    >
      {(["text", "kanban", "graph"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onChange(v)}
          className={`inline-flex min-h-11 items-center gap-1.5 px-3 text-xs ${
            view === v
              ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
              : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          }`}
        >
          {VIEW_ICON[v]}
          {t(`view.${v}`)}
        </button>
      ))}
    </div>
  );
}

/** Latest run's dot colour per lane; "not run" stays neutral. */
const RUN_DOT: Record<RunLane, string> = {
  new: "bg-[var(--color-border)]",
  todo: "bg-[var(--color-muted)]",
  running: "bg-[var(--color-accent)]",
  needs: "bg-[var(--color-warn)]",
  done: "bg-[var(--color-success)]",
};
const RUN_STROKE: Record<RunLane, string> = {
  new: "var(--color-border)",
  todo: "var(--color-muted)",
  running: "var(--color-accent)",
  needs: "var(--color-warn)",
  done: "var(--color-success)",
};

type RunState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; run: ProjectRun };

/** The latest run with its cards (`GET …/runs/{n}`), read once per run number. */
function useLatestRun(slug: string, runNo: number | null, enabled: boolean): RunState {
  const [loaded, setLoaded] = useState<{ runNo: number; run: ProjectRun | null } | null>(null);
  useEffect(() => {
    if (runNo == null || !enabled) return;
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(slug)}/runs/${runNo}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as ProjectRun;
      })
      .then((run) => !cancelled && setLoaded({ runNo, run }))
      .catch(() => !cancelled && setLoaded({ runNo, run: null }));
    return () => {
      cancelled = true;
    };
  }, [slug, runNo, enabled]);
  if (runNo == null) return { status: "none" };
  if (loaded?.runNo !== runNo) return { status: "loading" };
  return loaded.run ? { status: "ready", run: loaded.run } : { status: "failed" };
}

/**
 * Plan steps as cards: a Kanban with lanes by the latest run's card states
 * or by planning stage (Draft / Ready / Checkpoint), or a Graph built from
 * `depends_on` (a list on phones, where a wide graph can't fit). Every card
 * opens the step; it can be changed there when the plan can take a new
 * revision.
 */
export function PlaybookCards({
  slug,
  playbook,
  view,
  latestRunNo,
  profiles,
  hostProfile,
  archived,
  canPropose = true,
  rev: shown = null,
  onProposed,
  draft = null,
  onAsk,
}: {
  slug: string;
  playbook: ProjectPlaybookResponse;
  view: Exclude<CardsView, "text">;
  latestRunNo: number | null;
  profiles: string[];
  hostProfile: string | null;
  archived: boolean;
  /** A member or lead; read-only viewers can open a step but not change it. */
  canPropose?: boolean;
  /** The version picked above; the newest proposal (else the active one) when unset. */
  rev?: PlaybookRev | null;
  /** A step edit was saved as this new proposal. */
  onProposed?: (rev: number) => void;
  /** A working draft is shown: its label, what it changed, and why its cards are read-only. */
  draft?: { label: string; changes: Map<string, StepChange>; locked: string } | null;
  /** "Ask about this" from an opened card or node. */
  onAsk?: (quote: string) => void;
}) {
  const t = useT("playbookCards");
  const [lanesBy, setLanesBy] = useState<LanesBy>("run");
  const [editKey, setEditKey] = useState<string | null>(null);
  const active = playbook.active ?? null;
  const rev = shown ?? cardsRev(playbook.revisions ?? [], active);
  const steps = useMemo(() => rev?.steps ?? [], [rev]);
  const needsRun = view === "graph" || lanesBy === "run";
  const runState = useLatestRun(slug, latestRunNo, needsRun);
  const runLanes = useMemo(() => {
    if (runState.status !== "ready") return runLanesForSteps(steps, null, null);
    const { run } = runState;
    const ran =
      run.playbook_rev == null || run.playbook_rev === rev?.rev
        ? null
        : ((playbook.revisions ?? []).find((r) => r.rev === run.playbook_rev) ??
            (active?.rev === run.playbook_rev ? active : null));
    return runLanesForSteps(steps, run.cards, ran ? (ran.steps ?? []) : null);
  }, [runState, steps, rev, playbook.revisions, active]);

  if (!rev) return null;
  const state = revisionState(rev, active?.rev);
  const proposed = state === "proposed";
  const nextRev =
    Math.max(rev.rev, active?.rev ?? 0, ...(playbook.revisions ?? []).map((r) => r.rev)) + 1;
  // A change from a card is always a new proposal based on the version
  // shown — never blocked by (or folded into) another waiting proposal.
  const lockedReason = draft
    ? draft.locked
    : archived
      ? t("edit.archived")
      : !canPropose
        ? t("edit.viewOnly")
        : null;

  const runCaption = () => {
    switch (runState.status) {
      case "none":
        return t("caption.noRun");
      case "loading":
        return t("caption.runLoading");
      case "failed":
        return t("caption.runFailed");
      case "ready":
        return runState.run.playbook_rev != null
          ? t("caption.runPinned", { run: runState.run.run_no, rev: runState.run.playbook_rev })
          : t("caption.run", { run: runState.run.run_no });
    }
  };

  return (
    <StepChangeContext.Provider value={draft?.changes ?? NO_CHANGES}>
    <div data-component="PlaybookCards" data-view={view} className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-component="CardsRev"
          className={`rounded-full px-2.5 py-1 text-xs ${
            proposed || draft
              ? "bg-[var(--color-attention-bg)] text-[var(--color-warn-text)]"
              : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
          }`}
        >
          {draft ? draft.label : t(`showing.${state}`, { rev: rev.rev })}
        </span>
        {view === "kanban" ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-muted)]">{t("lanesBy.label")}</span>
            <div
              role="group"
              aria-label={t("lanesBy.label")}
              data-component="LanesBySwitch"
              className="inline-flex overflow-hidden rounded-lg border border-[var(--color-border)]"
            >
              {(["run", "plan"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={lanesBy === v}
                  onClick={() => setLanesBy(v)}
                  className={`min-h-11 px-3 text-xs ${
                    lanesBy === v
                      ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  {t(`lanesBy.${v}`)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <p data-component="CardsCaption" className="text-xs text-[var(--color-muted)]">
        {view === "graph"
          ? t("caption.graph")
          : lanesBy === "plan"
            ? active
              ? t("caption.plan")
              : t("caption.planNoActive")
            : runCaption()}
      </p>

      {steps.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{t("noSteps")}</p>
      ) : view === "kanban" ? (
        <Kanban
          steps={steps}
          lanesBy={lanesBy}
          active={active}
          runLanes={runLanes}
          hostProfile={hostProfile}
          onOpen={setEditKey}
        />
      ) : (
        <>
          <Legend />
          <div className="hidden sm:block">
            <Graph steps={steps} runLanes={runLanes} hostProfile={hostProfile} onOpen={setEditKey} />
          </div>
          <div className="sm:hidden">
            <GraphList steps={steps} runLanes={runLanes} hostProfile={hostProfile} onOpen={setEditKey} />
          </div>
        </>
      )}

      {editKey != null ? (
        <StepEditSheet
          key={`${rev.rev}:${editKey}`}
          slug={slug}
          rev={rev}
          stepKey={editKey}
          profiles={profiles}
          hostProfile={hostProfile}
          lockedReason={lockedReason}
          nextRev={nextRev}
          onClose={() => setEditKey(null)}
          onSaved={onProposed}
          askWhere={draft ? draft.label : t("chip", { rev: rev.rev })}
          onAsk={onAsk}
        />
      ) : null}
    </div>
    </StepChangeContext.Provider>
  );
}

const NO_CHANGES = new Map<string, StepChange>();
/** What the shown working draft changed, by step key; empty for a revision. */
const StepChangeContext = createContext<Map<string, StepChange>>(NO_CHANGES);

function ChangeTag({ stepKey }: { stepKey: string }) {
  const t = useT("playbook");
  const change = useContext(StepChangeContext).get(stepKey);
  if (!change) return null;
  return (
    <span
      data-change={change}
      className="rounded-full bg-[var(--color-attention-bg)] px-1.5 text-[10px] font-medium text-[var(--color-warn-text)]"
    >
      {t(`draft.${change}`)}
    </span>
  );
}

function useChanged(stepKey: string): boolean {
  return useContext(StepChangeContext).has(stepKey);
}

function useStepNames(steps: PlaybookStep[]) {
  const t = useT("playbookCards");
  const titleByKey = new Map(steps.map((s) => [s.key, s.title]));
  return {
    after: (step: PlaybookStep) => {
      const names = stepDeps(step)
        .map((d) => titleByKey.get(d))
        .filter((n): n is string => Boolean(n));
      return names.length ? t("card.after", { steps: names.join(", ") }) : null;
    },
  };
}

function Who({ step, hostProfile }: { step: PlaybookStep; hostProfile: string | null }) {
  const t = useT("playbookCards");
  const label = step.assignee
    ? step.assignee
    : hostProfile
      ? t("card.host", { profile: hostProfile })
      : t("card.nobody");
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-[var(--color-muted)]">
      <UserIcon size={12} />
      <span className="truncate">{label}</span>
    </span>
  );
}

function CheckpointTag() {
  const t = useT("playbookCards");
  return (
    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-[var(--color-warn-text)]">
      {t("card.checkpoint")}
    </span>
  );
}

function StepCard({
  step,
  hostProfile,
  after,
  onOpen,
}: {
  step: PlaybookStep;
  hostProfile: string | null;
  after: string | null;
  onOpen: (key: string) => void;
}) {
  const t = useT("playbookCards");
  const changed = useChanged(step.key);
  return (
    <button
      type="button"
      data-component="StepCard"
      data-changed={changed ? "true" : undefined}
      data-step={step.key}
      aria-label={t("card.open", { title: step.title })}
      onClick={() => onOpen(step.key)}
      className={`flex min-h-11 w-full flex-col gap-1 rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-left text-sm hover:border-[var(--color-accent)] ${
        step.checkpoint ? "border-dashed border-[var(--color-warn)]" : "border-[var(--color-border)]"
      } ${changed ? "ring-2 ring-[var(--color-warn)]" : ""}`}
    >
      <span className="font-medium leading-snug">{step.title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Who step={step} hostProfile={hostProfile} />
        {step.checkpoint ? <CheckpointTag /> : null}
        <ChangeTag stepKey={step.key} />
      </span>
      {after ? <span className="text-[11px] text-[var(--color-muted)]">{after}</span> : null}
    </button>
  );
}

function Kanban({
  steps,
  lanesBy,
  active,
  runLanes,
  hostProfile,
  onOpen,
}: {
  steps: PlaybookStep[];
  lanesBy: LanesBy;
  active: PlaybookRev | null;
  runLanes: Map<string, RunLane>;
  hostProfile: string | null;
  onOpen: (key: string) => void;
}) {
  const t = useT("playbookCards");
  const names = useStepNames(steps);
  const lanes: readonly string[] = lanesBy === "plan" ? PLAN_LANES : RUN_LANES;
  const laneOf = (s: PlaybookStep): string =>
    lanesBy === "plan" ? planLane(s, active) : runLane(s, runLanes);
  return (
    <div
      data-component="StepKanban"
      data-lanes={lanesBy}
      className="-mx-1 flex snap-x items-start gap-2 overflow-x-auto px-1 pb-2 sm:items-stretch"
    >
      {lanes.map((lane) => {
        const inLane = steps.filter((s) => laneOf(s) === lane);
        return (
          <section
            key={lane}
            data-lane={lane}
            aria-label={t(`lane.${lane}`)}
            className="flex w-56 shrink-0 snap-start flex-col gap-2 rounded-xl bg-[var(--color-surface-2)] p-2 sm:w-auto sm:min-w-44 sm:flex-1"
          >
            <h3 className="flex items-center justify-between px-1 text-xs font-medium">
              <span>{t(`lane.${lane}`)}</span>
              <span className="text-[var(--color-muted)]">{inLane.length}</span>
            </h3>
            {inLane.length === 0 ? (
              <p className="px-1 text-xs text-[var(--color-muted)]">{t("card.empty")}</p>
            ) : (
              inLane.map((s) => (
                <StepCard
                  key={s.key}
                  step={s}
                  hostProfile={hostProfile}
                  after={names.after(s)}
                  onOpen={onOpen}
                />
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}

function Legend() {
  const t = useT("playbookCards");
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-[var(--color-muted)]" data-component="GraphLegend">
      {RUN_LANES.map((lane) => (
        <li key={lane} className="inline-flex items-center gap-1">
          <span className={`h-2 w-2 rounded-full ${RUN_DOT[lane]}`} aria-hidden="true" />
          {t(`lane.${lane}`)}
        </li>
      ))}
    </ul>
  );
}

/** A column-skipping edge: up into its channel above the nodes, across, then down. */
function channelPath(x1: number, y1: number, x2: number, y2: number, yc: number): string {
  const r = 10;
  return `M${x1} ${y1} C${x1 + r} ${y1} ${x1 + r} ${yc} ${x1 + 2 * r} ${yc} L${x2 - 2 * r} ${yc} C${x2 - r} ${yc} ${x2 - r} ${y2} ${x2} ${y2}`;
}

function Graph({
  steps,
  runLanes,
  hostProfile,
  onOpen,
}: {
  steps: PlaybookStep[];
  runLanes: Map<string, RunLane>;
  hostProfile: string | null;
  onOpen: (key: string) => void;
}) {
  const t = useT("playbookCards");
  const layout = useMemo(() => graphLayout(steps), [steps]);
  const pos = new Map(layout.nodes.map((n) => [n.step.key, n]));
  const pad = 12;
  return (
    <div
      data-component="StepGraph"
      role="group"
      aria-label={t("graph.aria")}
      className="overflow-x-auto rounded-xl bg-[var(--color-surface-2)]"
    >
      <div
        className="relative"
        style={{ width: layout.width + pad * 2, height: layout.height + pad * 2 }}
      >
        <svg
          className="absolute inset-0"
          width={layout.width + pad * 2}
          height={layout.height + pad * 2}
          aria-hidden="true"
        >
          <defs>
            <marker id="step-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 8 4 0 8z" fill="var(--color-muted)" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            const x1 = a.x + NODE_W + pad;
            const y1 = a.y + NODE_H / 2 + pad;
            const x2 = b.x + pad - 2;
            const y2 = b.y + NODE_H / 2 + pad;
            const mid = (x1 + x2) / 2;
            const d =
              e.channelY == null
                ? `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
                : channelPath(x1, y1, x2, y2, e.channelY + pad);
            return (
              <path
                key={`${e.from}->${e.to}`}
                data-edge={`${e.from}->${e.to}`}
                d={d}
                fill="none"
                stroke="var(--color-muted)"
                strokeWidth={1.25}
                markerEnd="url(#step-graph-arrow)"
              />
            );
          })}
        </svg>
        {layout.nodes.map((n) => {
          const lane = runLane(n.step, runLanes);
          return (
            <button
              key={n.step.key}
              type="button"
              data-component="StepNode"
              data-step={n.step.key}
              data-run-lane={lane}
              aria-label={t("card.open", { title: n.step.title })}
              title={n.step.title}
              onClick={() => onOpen(n.step.key)}
              className={`absolute flex flex-col justify-center gap-0.5 rounded-lg border-2 bg-[var(--color-surface)] px-2 text-left hover:shadow ${
                n.step.checkpoint ? "border-dashed" : ""
              }`}
              style={{
                left: n.x + pad,
                top: n.y + pad,
                width: NODE_W,
                height: NODE_H,
                borderColor: RUN_STROKE[lane],
              }}
            >
              <span className="flex items-center gap-1 text-xs font-medium">
                <span className={`h-2 w-2 shrink-0 rounded-full ${RUN_DOT[lane]}`} aria-hidden="true" />
                <span className="truncate">{n.step.title}</span>
                <ChangeTag stepKey={n.step.key} />
              </span>
              <Who step={n.step} hostProfile={hostProfile} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Phone fallback for the Graph: steps by depth, each with what it waits on. */
function GraphList({
  steps,
  runLanes,
  hostProfile,
  onOpen,
}: {
  steps: PlaybookStep[];
  runLanes: Map<string, RunLane>;
  hostProfile: string | null;
  onOpen: (key: string) => void;
}) {
  const t = useT("playbookCards");
  const names = useStepNames(steps);
  const levels = stepLevels(steps);
  const ordered = steps
    .map((s, i) => ({ s, i, level: levels.get(s.key) ?? 0 }))
    .sort((a, b) => a.level - b.level || a.i - b.i);
  return (
    <ol data-component="StepGraphList" aria-label={t("caption.graphList")} className="flex flex-col gap-1.5">
      {ordered.map(({ s, level }) => {
        const lane = runLane(s, runLanes);
        return (
          <li key={s.key} data-step={s.key} data-level={level} style={{ marginLeft: `${Math.min(level, 4) * 0.75}rem` }}>
            <button
              type="button"
              aria-label={t("card.open", { title: s.title })}
              onClick={() => onOpen(s.key)}
              className={`flex min-h-11 w-full items-start gap-2 rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-left text-sm ${
                s.checkpoint ? "border-dashed border-[var(--color-warn)]" : "border-[var(--color-border)]"
              }`}
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${RUN_DOT[lane]}`} aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">{s.title}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Who step={s} hostProfile={hostProfile} />
                  {s.checkpoint ? <CheckpointTag /> : null}
                  <ChangeTag stepKey={s.key} />
                  <span className="text-[11px] text-[var(--color-muted)]">
                    {t(`lane.${lane}`)}
                  </span>
                </span>
                <span className="text-[11px] text-[var(--color-muted)]">
                  {names.after(s) ?? t("graph.start")}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
