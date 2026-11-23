import { describe, expect, it } from "vitest";

import type { PlaybookRev, PlaybookStep, ProjectRunCard } from "@/types";

import {
  PLAN_LANES,
  RUN_LANES,
  cardsRev,
  dependents,
  graphLayout,
  planLane,
  runLaneForStatus,
  runLanesByStep,
  runLanesForSteps,
  stepLevels,
  stepsWithEdit,
} from "./stepCards";

const step = (key: string, extra: Partial<PlaybookStep> = {}): PlaybookStep => ({
  key,
  title: key,
  depends_on: [],
  checkpoint: false,
  ...extra,
});

const rev = (n: number, steps: PlaybookStep[], active = 0): PlaybookRev => ({
  project_id: "p",
  rev: n,
  body: "",
  steps,
  active,
  created_by: null,
  created_at: n,
  activated_at: null,
  note: null,
});

const STEPS = [
  step("pull"),
  step("clean", { depends_on: ["pull"] }),
  step("chart", { depends_on: ["clean"] }),
  step("outliers", { depends_on: ["clean"] }),
  step("review", { depends_on: ["chart", "outliers"], checkpoint: true }),
];

describe("planning-stage lanes", () => {
  const active = rev(4, STEPS.slice(0, 3), 1);

  it("puts every checkpoint in Checkpoint, whatever changed", () => {
    expect(planLane(step("x", { checkpoint: true }), active)).toBe("checkpoint");
    expect(planLane(step("x", { checkpoint: true }), null)).toBe("checkpoint");
  });

  it("is Ready exactly when the step is unchanged vs the active revision", () => {
    for (const s of active.steps!) expect(planLane({ ...s }, active)).toBe("ready");
    const base = active.steps![1];
    const edits: Partial<PlaybookStep>[] = [
      { title: "Clean better" },
      { body: "more detail" },
      { assignee: "finance" },
      { depends_on: [] },
    ];
    for (const e of edits) expect(planLane({ ...base, ...e }, active)).toBe("draft");
  });

  it("treats a new step, or a plan with nothing active, as Draft", () => {
    expect(planLane(step("new"), active)).toBe("draft");
    expect(planLane(STEPS[0], null)).toBe("draft");
  });

  it("reads legacy `needs` the same as `depends_on`", () => {
    const legacy = { ...active.steps![1], depends_on: undefined, needs: ["pull"] } as PlaybookStep;
    expect(planLane(legacy, active)).toBe("ready");
  });

  it("only ever yields a declared lane", () => {
    for (const s of STEPS) expect(PLAN_LANES).toContain(planLane(s, active));
  });
});

describe("latest-run lanes", () => {
  it("maps every kanban status to a declared lane", () => {
    for (const status of ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived", null]) {
      expect(RUN_LANES).toContain(runLaneForStatus(status));
    }
    expect(runLaneForStatus("blocked")).toBe("needs");
    expect(runLaneForStatus("done")).toBe("done");
    expect(runLaneForStatus(undefined)).toBe("new");
  });

  it("keys lanes by step, skips ad-hoc cards, and lets an open retry beat a done card", () => {
    const card = (step_key: string | null, status: string): ProjectRunCard => ({
      task_id: `${step_key}-${status}`,
      step_key,
      status,
      title: null,
    });
    const lanes = runLanesByStep([
      card("pull", "done"),
      card("clean", "done"),
      card("clean", "running"),
      card(null, "blocked"),
    ]);
    expect(lanes.get("pull")).toBe("done");
    expect(lanes.get("clean")).toBe("running");
    expect(lanes.has("chart")).toBe(false);
    expect([...lanes.keys()]).not.toContain(null);
  });
});

describe("latest-run lanes across revisions", () => {
  const cards = [
    { task_id: "a", step_key: "pull", status: "done", title: "" },
    { task_id: "b", step_key: "clean", status: "done", title: "" },
  ] as unknown as ProjectRunCard[];

  it("keeps a run's state only for steps unchanged since the revision it ran", () => {
    const ran = [step("pull"), step("clean", { depends_on: ["pull"] })];
    const shown = [
      step("pull"),
      step("clean", { depends_on: ["pull"], body: "import two files" }),
      step("chart", { depends_on: ["clean"] }),
    ];
    const lanes = runLanesForSteps(shown, cards, ran);
    expect(lanes.get("pull")).toBe("done");
    expect(lanes.has("clean")).toBe(false);
    expect(lanes.has("chart")).toBe(false);
  });

  it("matches by key alone when the run's revision is the one shown or unknown", () => {
    expect(runLanesForSteps(STEPS, cards, null)).toEqual(runLanesByStep(cards));
  });
});

describe("graph", () => {
  it("places every step one level past its deepest dependency", () => {
    const levels = stepLevels(STEPS);
    for (const s of STEPS) {
      const deps = s.depends_on ?? [];
      if (deps.length === 0) expect(levels.get(s.key)).toBe(0);
      else expect(levels.get(s.key)).toBe(1 + Math.max(...deps.map((d) => levels.get(d)!)));
    }
  });

  it("still draws a revision with a cycle or an unknown dependency", () => {
    const bad = [step("a", { depends_on: ["b"] }), step("b", { depends_on: ["a", "ghost"] })];
    const layout = graphLayout(bad);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges.every((e) => e.from !== "ghost")).toBe(true);
  });

  it("draws one edge per dependency, left to right, with nodes that don't overlap", () => {
    const layout = graphLayout(STEPS);
    const at = new Map(layout.nodes.map((n) => [n.step.key, n]));
    expect(layout.edges).toHaveLength(STEPS.reduce((n, s) => n + (s.depends_on?.length ?? 0), 0));
    for (const e of layout.edges) expect(at.get(e.from)!.x).toBeLessThan(at.get(e.to)!.x);
    const spots = new Set(layout.nodes.map((n) => `${n.x}:${n.y}`));
    expect(spots.size).toBe(layout.nodes.length);
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(layout.width);
      expect(n.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("routes an edge that skips a column through its own channel above every node", () => {
    const layout = graphLayout([
      step("a"),
      step("b", { depends_on: ["a"] }),
      step("c", { depends_on: ["a", "b"] }),
      step("d", { depends_on: ["a"] }),
    ]);
    const top = Math.min(...layout.nodes.map((n) => n.y));
    const long = layout.edges.filter((e) => e.channelY != null);
    expect(long.map((e) => `${e.from}->${e.to}`)).toEqual(["a->c"]);
    for (const e of long) {
      expect(e.channelY!).toBeGreaterThanOrEqual(0);
      expect(e.channelY!).toBeLessThan(top);
    }
    const ys = long.map((e) => e.channelY);
    expect(new Set(ys).size).toBe(ys.length);
    for (const e of layout.edges.filter((e) => e.channelY == null)) {
      const lv = (k: string) => layout.nodes.find((n) => n.step.key === k)!.level;
      expect(lv(e.to) - lv(e.from)).toBe(1);
    }
  });

  it("lists every transitive dependent, so a step can't be made to wait on one", () => {
    expect([...dependents(STEPS, "clean")].sort()).toEqual(["chart", "outliers", "review"]);
    expect(dependents(STEPS, "review").size).toBe(0);
  });
});

describe("what counts as a changed step", () => {
  it("treats a change to only the step's tools as Draft", () => {
    const active = rev(4, [step("pull", { toolsets: ["file", "terminal"] })], 1);
    expect(planLane(step("pull", { toolsets: ["terminal", "file"] }), active)).toBe("ready");
    expect(planLane(step("pull", { toolsets: ["file"] }), active)).toBe("draft");
  });
});

describe("editing a step from its card", () => {
  it("changes only that step and carries every field the card doesn't show", () => {
    const steps = [
      step("pull", { toolsets: ["file"], mode: "card" } as Partial<PlaybookStep>),
      step("clean", {
        depends_on: ["pull"],
        needs: ["pull"],
        assignee: "ops",
        assignee_reason: "Ops owns the CRM.",
        assigned_by: "planner",
      }),
    ];
    const out = stepsWithEdit(
      steps,
      "clean",
      { title: "  Clean rows ", body: "", assignee: "finance", dependsOn: [], checkpoint: true },
      { assigned_by: "manual" },
    );
    expect(out[0]).toBe(steps[0]);
    expect(out[1]).toMatchObject({
      key: "clean",
      title: "Clean rows",
      body: null,
      assignee: "finance",
      depends_on: [],
      checkpoint: true,
      assigned_by: "manual",
    });
    expect(out[1]).not.toHaveProperty("needs");
    expect(out[1]).not.toHaveProperty("assignee_reason");
  });
});

describe("editing keeps what wasn't touched", () => {
  it("keeps the details' formatting when only the title changes", () => {
    const body = "  1. first\n  2. second\n";
    const [next] = stepsWithEdit([step("a", { body })], "a", { title: "A2", body, assignee: "", dependsOn: [], checkpoint: false }, {});
    expect(next.body).toBe(body);
    const [cleared] = stepsWithEdit([step("a", { body })], "a", { title: "A2", body: "  ", assignee: "", dependsOn: [], checkpoint: false }, {});
    expect(cleared.body).toBeNull();
  });
});

describe("which revision the cards show", () => {
  it("shows the newest pending proposal, else the active revision", () => {
    const active = rev(4, STEPS, 1);
    expect(cardsRev([rev(3, []), active], active)).toBe(active);
    const v5 = rev(5, STEPS);
    const v6 = rev(6, STEPS);
    expect(cardsRev([rev(3, []), active, v5, v6], active)).toBe(v6);
    expect(cardsRev([v5], null)).toBe(v5);
    expect(cardsRev([], null)).toBeNull();
  });
});
