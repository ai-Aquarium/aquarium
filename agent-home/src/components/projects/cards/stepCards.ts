/**
 * Playbook steps as cards — pure derivations, no React.
 *
 * The Planning tab shows a revision's steps as a Kanban (lanes by the latest
 * run's card states, or by planning stage) or as a Graph built from each
 * step's `depends_on`. Nothing here is stored: lanes and levels are read
 * from the revision, the active revision and the latest run's cards.
 */

import { ASSIGNMENT_FIELDS } from "@/components/projects/plan/StepAssignment";
import type { PlaybookRev, PlaybookStep, ProjectRunCard } from "@/types";

export type CardsView = "text" | "kanban" | "graph";
export type LanesBy = "run" | "plan";

export const RUN_LANES = ["new", "todo", "running", "needs", "done"] as const;
export type RunLane = (typeof RUN_LANES)[number];

export const PLAN_LANES = ["draft", "ready", "checkpoint"] as const;
export type PlanLane = (typeof PLAN_LANES)[number];

/** The keys a step waits on (`needs` is the legacy name). */
export function stepDeps(step: PlaybookStep): string[] {
  return step.depends_on ?? step.needs ?? [];
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((value, i) => value === sorted[i]);
}

/** True when anything a person edits on a step differs between two copies. */
export function stepChanged(step: PlaybookStep, base: PlaybookStep): boolean {
  return (
    step.title !== base.title ||
    (step.body ?? "") !== (base.body ?? "") ||
    (step.assignee ?? "") !== (base.assignee ?? "") ||
    Boolean(step.checkpoint) !== Boolean(base.checkpoint) ||
    !sameList(stepDeps(step), stepDeps(base))
  );
}

/**
 * Planning stage: a checkpoint step waits for a person whatever else is
 * true; otherwise a step is Draft when it is new or changed against the
 * active revision (or there is no active one), and Ready when unchanged.
 */
export function planLane(step: PlaybookStep, active: PlaybookRev | null): PlanLane {
  if (step.checkpoint) return "checkpoint";
  const base = active?.steps?.find((s) => s.key === step.key);
  if (!base) return "draft";
  return stepChanged(step, base) ? "draft" : "ready";
}

/** One kanban stage → the lane a person reads in "Latest run". */
export function runLaneForStatus(status: string | null | undefined): RunLane {
  switch (status) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "blocked":
    case "review":
      return "needs";
    case "triage":
    case "todo":
    case "scheduled":
    case "ready":
      return "todo";
    default:
      // No card, or an archived one: the step did not run.
      return "new";
  }
}

/** When a step made several cards (a retry, a re-plan), the open one wins. */
const RUN_LANE_WEIGHT: Record<RunLane, number> = {
  needs: 4,
  running: 3,
  todo: 2,
  done: 1,
  new: 0,
};

/** Each step key's lane in a run; steps without a card are absent. */
export function runLanesByStep(cards: ProjectRunCard[] | null | undefined): Map<string, RunLane> {
  const out = new Map<string, RunLane>();
  for (const card of cards ?? []) {
    if (!card.step_key) continue;
    const lane = runLaneForStatus(card.status);
    const prev = out.get(card.step_key);
    if (prev == null || RUN_LANE_WEIGHT[lane] > RUN_LANE_WEIGHT[prev]) {
      out.set(card.step_key, lane);
    }
  }
  return out;
}

export function runLane(step: PlaybookStep, lanes: Map<string, RunLane>): RunLane {
  return lanes.get(step.key) ?? "new";
}

/**
 * Graph depth of every step: 0 when it waits on nothing, else one more than
 * its deepest dependency. Unknown keys are ignored and a cycle (which the
 * server refuses on save) is cut, so a bad revision still draws.
 */
export function stepLevels(steps: PlaybookStep[]): Map<string, number> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (key: string): number => {
    const known = levels.get(key);
    if (known != null) return known;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const step = byKey.get(key)!;
    const deps = stepDeps(step).filter((d) => byKey.has(d) && d !== key);
    const value = deps.length ? 1 + Math.max(...deps.map(level)) : 0;
    visiting.delete(key);
    levels.set(key, value);
    return value;
  };
  for (const step of steps) level(step.key);
  return levels;
}

export interface GraphNode {
  step: PlaybookStep;
  level: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_W = 132;
export const NODE_H = 52;
const GAP_X = 28;
const GAP_Y = 20;

/** Left-to-right layered layout: one column per level, centred columns. */
export function graphLayout(steps: PlaybookStep[]): GraphLayout {
  const levels = stepLevels(steps);
  const columns = new Map<number, PlaybookStep[]>();
  for (const step of steps) {
    const l = levels.get(step.key) ?? 0;
    columns.set(l, [...(columns.get(l) ?? []), step]);
  }
  const tallest = Math.max(0, ...[...columns.values()].map((c) => c.length));
  const nodes: GraphNode[] = [];
  for (const [l, column] of columns) {
    const offset = (tallest - column.length) / 2;
    column.forEach((step, i) => {
      nodes.push({
        step,
        level: l,
        x: l * (NODE_W + GAP_X),
        y: (i + offset) * (NODE_H + GAP_Y),
      });
    });
  }
  const keys = new Set(steps.map((s) => s.key));
  const edges = steps.flatMap((s) =>
    stepDeps(s)
      .filter((d) => keys.has(d) && d !== s.key)
      .map((d) => ({ from: d, to: s.key })),
  );
  const depth = columns.size;
  return {
    nodes,
    edges,
    width: Math.max(0, depth * (NODE_W + GAP_X) - GAP_X),
    height: Math.max(0, tallest * (NODE_H + GAP_Y) - GAP_Y),
  };
}

/** Every step that (transitively) waits on `key` — it can't be a dependency of `key`. */
export function dependents(steps: PlaybookStep[], key: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of steps) {
      if (out.has(step.key) || step.key === key) continue;
      if (stepDeps(step).some((d) => d === key || out.has(d))) {
        out.add(step.key);
        grew = true;
      }
    }
  }
  return out;
}

export interface StepEdit {
  title: string;
  body: string;
  assignee: string;
  dependsOn: string[];
  checkpoint: boolean;
}

/**
 * The revision's steps with one step replaced by its edit — every other
 * step, and every field the card editor doesn't show, carried as-is. The
 * step's C-3 "why this profile" fields are replaced by `assignment` (from
 * `assignmentForSave`), so a hand-picked assignee drops a stale reason.
 */
export function stepsWithEdit(
  steps: PlaybookStep[],
  key: string,
  edit: StepEdit,
  assignment: Record<string, unknown>,
): PlaybookStep[] {
  return steps.map((step) => {
    if (step.key !== key) return step;
    const next: PlaybookStep = { ...step };
    for (const field of ASSIGNMENT_FIELDS) delete next[field];
    Object.assign(next, {
      title: edit.title.trim(),
      body: edit.body.trim() || null,
      assignee: edit.assignee || null,
      depends_on: edit.dependsOn,
      checkpoint: edit.checkpoint,
      ...assignment,
    });
    delete next.needs;
    return next;
  });
}

/** The revision cards show: the newest pending proposal, else the active one. */
export function cardsRev(revisions: PlaybookRev[], active: PlaybookRev | null): PlaybookRev | null {
  const pending = revisions.filter((r) => !r.active && (active == null || r.rev > active.rev));
  if (pending.length === 0) return active;
  return pending.reduce((a, b) => (b.rev > a.rev ? b : a));
}
