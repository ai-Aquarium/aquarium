import { describe, expect, it } from "vitest";

import type { ProjectRun, ProjectRunBrief, ProjectRunCard } from "@/types";

import {
  COMPARE_MAX,
  cardSeconds,
  cardState,
  compareRows,
  currentRunNo,
  scoreTrend,
  toggleCompare,
} from "./runStats";

const card = (over: Partial<ProjectRunCard>): ProjectRunCard => ({
  task_id: "t1",
  step_key: "gather",
  status: "todo",
  title: "Gather",
  ...over,
});

const brief = (run_no: number, over: Partial<ProjectRunBrief> = {}): ProjectRunBrief => ({
  run_no,
  status: "done",
  trigger: "manual",
  started_at: 1000 * run_no,
  ended_at: 1000 * run_no + 60,
  duration_seconds: 60,
  outcome: null,
  score_user: null,
  ...over,
});

const run = (run_no: number, cards: ProjectRunCard[], over: Partial<ProjectRun> = {}) =>
  ({ run_no, status: "done", cards, ...over }) as ProjectRun;

describe("cardState", () => {
  it("calls anything waiting on a person 'needs you', whatever the column", () => {
    const r = { waiting_on_you: [{ task_id: "t1", title: null, block_kind: "x", reason: null }] };
    expect(cardState(card({ status: "ready" }), r)).toBe("needs");
    expect(
      cardState(card({ status: "todo" }), {
        checkpoint_wait: { checkpoint_task_id: "t1", checkpoint_title: null, comment: null, held_task_ids: [] },
      }),
    ).toBe("needs");
    expect(cardState(card({ status: "review" }), {})).toBe("needs");
  });

  it("a finished card is done even if it once waited", () => {
    const r = { waiting_on_you: [{ task_id: "t1", title: null, block_kind: "x", reason: null }] };
    expect(cardState(card({ status: "done" }), r)).toBe("done");
  });

  it("maps working and queued columns", () => {
    expect(cardState(card({ status: "running" }), {})).toBe("running");
    for (const status of ["triage", "todo", "scheduled", "ready", null]) {
      expect(cardState(card({ status }), {})).toBe("todo");
    }
  });
});

describe("cardSeconds", () => {
  it("is null until the card finished and never negative", () => {
    expect(cardSeconds(card({ started_at: 10 }))).toBeNull();
    expect(cardSeconds(card({ started_at: 10, completed_at: 70 }))).toBe(60);
    expect(cardSeconds(card({ started_at: 70, completed_at: 10 }))).toBe(0);
  });
});

describe("currentRunNo", () => {
  it("leads with a live run over a newer finished one, else the newest", () => {
    expect(currentRunNo([])).toBeNull();
    expect(currentRunNo([brief(3), brief(4)])).toBe(4);
    expect(currentRunNo([brief(5), brief(4, { status: "waiting" })])).toBe(4);
  });
});

describe("toggleCompare", () => {
  it("keeps at most three runs, sorted, and refuses rather than swaps", () => {
    let sel: number[] = [];
    for (const n of [9, 7, 8]) sel = toggleCompare(sel, n);
    expect(sel).toEqual([7, 8, 9]);
    expect(toggleCompare(sel, 5)).toEqual(sel);
    expect(toggleCompare(sel, 8)).toEqual([7, 9]);
    expect(sel.length).toBeLessThanOrEqual(COMPARE_MAX);
  });
});

describe("scoreTrend", () => {
  it("plots only 1–5 human scores in run order and averages per version", () => {
    const runs = [
      brief(4, { score_user: 5, playbook_rev: 2 }),
      brief(3, { score_user: 4, playbook_rev: 2 }),
      brief(2, { score_user: null, playbook_rev: 1 }),
      brief(1, { score_user: 2, playbook_rev: 1 }),
    ];
    const { points, byRev } = scoreTrend(runs);
    expect(points.map((p) => p.run_no)).toEqual([1, 3, 4]);
    expect(points.every((p) => p.score >= 1 && p.score <= 5)).toBe(true);
    expect(byRev).toEqual([
      { rev: 1, average: 2, count: 1 },
      { rev: 2, average: 4.5, count: 2 },
    ]);
    // Every scored run lands in exactly one version bucket.
    expect(byRev.reduce((a, r) => a + r.count, 0)).toBe(points.length);
  });
});

describe("compareRows", () => {
  it("one row per step across runs, one cell per run, gaps for missing steps", () => {
    const a = run(7, [
      card({ task_id: "a1", step_key: "gather", status: "done", started_at: 0, completed_at: 120 }),
      card({ task_id: "a2", step_key: "send", title: "Send", status: "done", started_at: 0, completed_at: 30 }),
    ]);
    const b = run(8, [
      card({ task_id: "b1", step_key: "gather", status: "done", started_at: 0, completed_at: 60 }),
      card({ task_id: "b2", step_key: "review", title: "Review", status: "review" }),
    ]);
    const rows = compareRows([a, b]);
    expect(rows.map((r) => r.key)).toEqual(["gather", "send", "review"]);
    for (const row of rows) expect(row.cells).toHaveLength(2);
    const gather = rows[0];
    expect(gather.cells.map((c) => c.seconds)).toEqual([120, 60]);
    expect(gather.slowest).toBe(0);
    expect(rows[1].cells[1]).toEqual({ state: null, seconds: null });
    expect(rows[2].cells[1].state).toBe("needs");
    // A tie or a single timed cell names no slowest run.
    expect(rows[1].slowest).toBeNull();
  });
});
