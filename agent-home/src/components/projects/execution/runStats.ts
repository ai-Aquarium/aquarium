import type { ProjectRun, ProjectRunBrief, ProjectRunCard } from "@/types";

/** What a card shows in the compact current run (and in a compare row). */
export type CardState = "done" | "running" | "needs" | "todo" | "skipped";

/**
 * A card's state from the human's point of view: anything that waits on a
 * person (a block, a review, a held checkpoint) is "needs you", whatever the
 * board column says.
 */
export function cardState(
  card: ProjectRunCard,
  run: Pick<ProjectRun, "waiting_on_you" | "checkpoint_wait">,
): CardState {
  const waits = new Set((run.waiting_on_you ?? []).map((w) => w.task_id));
  const checkpoint = run.checkpoint_wait?.checkpoint_task_id;
  if (card.status === "done") return "done";
  if (card.status === "archived") return "skipped";
  if (waits.has(card.task_id) || (checkpoint && checkpoint === card.task_id)) return "needs";
  if (card.status === "blocked" || card.status === "review") return "needs";
  if (card.status === "running") return "running";
  return "todo";
}

/** How long a card's work took, or `null` when it never finished. */
export function cardSeconds(card: ProjectRunCard): number | null {
  if (card.started_at == null || card.completed_at == null) return null;
  return Math.max(0, card.completed_at - card.started_at);
}

/** The run the Execution tab leads with: the live one, else the newest. */
export function currentRunNo(runs: readonly ProjectRunBrief[]): number | null {
  if (runs.length === 0) return null;
  const live = runs.find(
    (r) => r.status === "running" || r.status === "waiting" || r.status === "blocked",
  );
  if (live) return live.run_no;
  return runs.reduce((a, b) => (b.run_no > a.run_no ? b : a)).run_no;
}

export const COMPARE_MAX = 3;
export const COMPARE_MIN = 2;

/** Tick or untick a run for comparison; a fourth tick is refused, not swapped. */
export function toggleCompare(selected: readonly number[], runNo: number): number[] {
  if (selected.includes(runNo)) return selected.filter((n) => n !== runNo);
  if (selected.length >= COMPARE_MAX) return [...selected];
  return [...selected, runNo].sort((a, b) => a - b);
}

export interface TrendPoint {
  run_no: number;
  score: number;
  rev: number | null;
}

export interface RevAverage {
  rev: number | null;
  average: number;
  count: number;
}

/** Human scores (1–5) in run order, and their average per playbook version. */
export function scoreTrend(runs: readonly ProjectRunBrief[]): {
  points: TrendPoint[];
  byRev: RevAverage[];
} {
  const points = runs
    .filter((r) => r.score_user != null && r.score_user >= 1 && r.score_user <= 5)
    .map((r) => ({ run_no: r.run_no, score: r.score_user as number, rev: r.playbook_rev ?? null }))
    .sort((a, b) => a.run_no - b.run_no);
  const groups = new Map<number | null, number[]>();
  for (const p of points) groups.set(p.rev, [...(groups.get(p.rev) ?? []), p.score]);
  const byRev = [...groups.entries()]
    .map(([rev, scores]) => ({
      rev,
      count: scores.length,
      average: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
    }))
    .sort((a, b) => (a.rev ?? -1) - (b.rev ?? -1));
  return { points, byRev };
}

export interface CompareCell {
  state: CardState | null;
  seconds: number | null;
}

export interface CompareRow {
  key: string;
  title: string;
  cells: CompareCell[];
  /**
   * Index of the clearly slowest run for this step: at least a minute and
   * a fifth longer than the next one, so near-ties are not flagged.
   */
  slowest: number | null;
}

/**
 * One row per playbook step across the compared runs (in the order the
 * steps first appear), one cell per run. A step a run did not have is an
 * empty cell, so a playbook change between versions stays visible.
 */
export function compareRows(runs: readonly ProjectRun[]): CompareRow[] {
  const order: string[] = [];
  const titles = new Map<string, string>();
  for (const run of runs) {
    for (const card of run.cards ?? []) {
      const key = card.step_key ?? card.task_id;
      if (!titles.has(key)) {
        order.push(key);
        titles.set(key, card.title ?? key);
      }
    }
  }
  return order.map((key) => {
    const cells = runs.map((run) => {
      const card = (run.cards ?? []).find((c) => (c.step_key ?? c.task_id) === key);
      return card
        ? { state: cardState(card, run), seconds: cardSeconds(card) }
        : { state: null, seconds: null };
    });
    const timed = cells
      .map((c, i) => [c.seconds, i] as const)
      .filter((pair): pair is readonly [number, number] => pair[0] != null);
    let slowest: number | null = null;
    if (timed.length >= 2) {
      const sorted = [...timed].sort((a, b) => b[0] - a[0]);
      const [first, second] = [sorted[0][0], sorted[1][0]];
      if (first - second >= 60 && first >= second * 1.2) slowest = sorted[0][1];
    }
    return { key, title: titles.get(key) ?? key, cells, slowest };
  });
}
