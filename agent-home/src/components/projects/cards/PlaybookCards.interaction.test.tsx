// @vitest-environment jsdom
/**
 * Stage 4: the Plan's steps as cards — Kanban lanes by the latest run or by
 * planning stage, a Graph (a list on phones), and a step edited from its card.
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/weekly",
  useRouter: () => router,
}));

import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import type { PlaybookRev, PlaybookStep, ProjectPlaybookResponse, ProjectRun } from "@/types";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const step = (key: string, extra: Partial<PlaybookStep> = {}): PlaybookStep => ({
  key,
  title: key[0].toUpperCase() + key.slice(1),
  depends_on: [],
  checkpoint: false,
  ...extra,
});

const V4: PlaybookStep[] = [
  step("pull", { assignee: "ops" }),
  step("clean", { depends_on: ["pull"], assignee: "finance" }),
  step("review", { depends_on: ["clean"], checkpoint: true }),
];

const rev = (n: number, steps: PlaybookStep[], active: number): PlaybookRev => ({
  project_id: "p",
  rev: n,
  body: "Weekly digest.",
  steps,
  active,
  created_by: "leo",
  created_at: n,
  activated_at: active ? n : null,
  note: null,
});

const RUN = {
  run_no: 8,
  playbook_rev: 4,
  status: "running",
  cards: [
    { task_id: "t1", step_key: "pull", status: "done", title: "Pull" },
    { task_id: "t2", step_key: "clean", status: "running", title: "Clean" },
  ],
} as unknown as ProjectRun;

function server() {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/projects/weekly/runs/8") return Promise.resolve(json(200, RUN));
    if (url === "/api/projects/weekly/playbook" && init?.method === "POST") {
      return Promise.resolve(json(200, { rev: 5, active: false }));
    }
    return Promise.resolve(json(200, { status: "idle", profiles: [] }));
  });
}

function mount(
  playbook: ProjectPlaybookResponse,
  extra: { archived?: boolean; latestRunNo?: number | null; canPropose?: boolean } = {},
) {
  return render(
    <PlanPanel
      slug="weekly"
      playbook={playbook}
      profiles={["ops", "finance"]}
      hostProfile="ops"
      canActivate
      archived={extra.archived ?? false}
      latestRunNo={extra.latestRunNo === undefined ? 8 : extra.latestRunNo}
      canPropose={extra.canPropose}
    />,
  );
}

const ACTIVE_ONLY: ProjectPlaybookResponse = { active: rev(4, V4, 1), revisions: [rev(4, V4, 1)] };

const laneKeys = (r: ReturnType<typeof render>, lane: string) =>
  Array.from(
    r.container.querySelectorAll(`[data-lane="${lane}"] [data-component="StepCard"]`),
  ).map((el) => (el as HTMLElement).dataset.step);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

describe("Plan as cards", () => {
  it("defaults to text and switches to a Kanban laid out by the latest run", async () => {
    vi.stubGlobal("fetch", server());
    const r = mount(ACTIVE_ONLY);
    expect(r.container.querySelector('[data-component="PlaybookCards"]')).toBeNull();
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    await waitFor(() => expect(laneKeys(r, "done")).toEqual(["pull"]));
    expect(laneKeys(r, "running")).toEqual(["clean"]);
    expect(laneKeys(r, "new")).toEqual(["review"]);
    expect(r.getByText(/run 8 \(revision 4\)/)).toBeTruthy();
    // One card per step, whatever the lanes.
    expect(r.container.querySelectorAll('[data-component="StepCard"]')).toHaveLength(V4.length);
  });

  it("re-lanes the same cards by planning stage against the active revision", async () => {
    vi.stubGlobal("fetch", server());
    const changed = V4.map((s) => (s.key === "clean" ? { ...s, title: "Clean and dedupe" } : s));
    const v5 = rev(5, [...changed, step("outliers", { depends_on: ["clean"] })], 0);
    const r = mount({ active: rev(4, V4, 1), revisions: [rev(4, V4, 1), v5] });
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    fireEvent.click(r.getByRole("button", { name: "Planning stage" }));
    expect(r.getByText("Revision 5 (proposed)")).toBeTruthy();
    expect(laneKeys(r, "draft").sort()).toEqual(["clean", "outliers"]);
    expect(laneKeys(r, "ready")).toEqual(["pull"]);
    expect(laneKeys(r, "checkpoint")).toEqual(["review"]);
    fireEvent.click(r.getByRole("button", { name: "Latest run" }));
    await waitFor(() => expect(laneKeys(r, "done")).toEqual(["pull"]));
  });

  it("puts every step in Not run yet before the first run, without asking for a run", () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const r = mount(ACTIVE_ONLY, { latestRunNo: null });
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    expect(laneKeys(r, "new")).toHaveLength(V4.length);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/runs/"))).toBe(false);
  });

  it("draws a Graph with an edge per dependency and a phone list of the same steps", async () => {
    vi.stubGlobal("fetch", server());
    const r = mount(ACTIVE_ONLY);
    fireEvent.click(r.getByRole("button", { name: "Graph" }));
    const graph = r.container.querySelector('[data-component="StepGraph"]') as HTMLElement;
    const list = r.container.querySelector('[data-component="StepGraphList"]') as HTMLElement;
    const edges = Array.from(graph.querySelectorAll("[data-edge]")).map((e) => e.getAttribute("data-edge"));
    expect(edges.sort()).toEqual(["clean->review", "pull->clean"]);
    const nodes = Array.from(graph.querySelectorAll('[data-component="StepNode"]')).map(
      (n) => (n as HTMLElement).dataset.step,
    );
    const rows = Array.from(list.querySelectorAll("li")).map((n) => (n as HTMLElement).dataset.step);
    expect(rows.sort()).toEqual([...nodes].sort());
    // The list keeps dependency order: nothing comes before what it waits on.
    const order = Array.from(list.querySelectorAll("li")).map((n) => (n as HTMLElement).dataset.step!);
    for (const s of V4) for (const d of s.depends_on ?? []) expect(order.indexOf(d)).toBeLessThan(order.indexOf(s.key));
    await waitFor(() =>
      expect((graph.querySelector('[data-step="pull"]') as HTMLElement).dataset.runLane).toBe("done"),
    );
  });

  it("edits a step from its card and saves only that step as a proposal on the shown revision", async () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const r = mount(ACTIVE_ONLY);
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    fireEvent.click(r.getByRole("button", { name: "Open step: Clean" }));
    const sheet = within(document.querySelector('[data-component="StepEditSheet"]') as HTMLElement);
    // A step can't be made to wait on a step that waits on it.
    expect(sheet.queryByLabelText("Review")).toBeNull();
    fireEvent.change(sheet.getByDisplayValue("Clean"), { target: { value: "Clean rows" } });
    fireEvent.click(sheet.getByLabelText(/Checkpoint/));
    fireEvent.click(sheet.getByRole("button", { name: "Save as a new revision" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/projects/weekly/playbook" && i?.method === "POST")).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(([u, i]) => u === "/api/projects/weekly/playbook" && i?.method === "POST")!;
    const sent = JSON.parse(String(init!.body));
    expect(sent.base_rev).toBe(4);
    expect(sent.body).toBe("Weekly digest.");
    expect(sent.steps.map((s: PlaybookStep) => s.key)).toEqual(V4.map((s) => s.key));
    expect(sent.steps[1]).toMatchObject({ title: "Clean rows", checkpoint: true, depends_on: ["pull"], assignee: "finance" });
    expect(sent.steps[0]).toEqual(V4[0]);
    expect(sent.steps[2]).toEqual(V4[2]);
  });

  it("opens a step read-only when the project is archived", () => {
    vi.stubGlobal("fetch", server());
    const r = mount(ACTIVE_ONLY, { archived: true });
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    fireEvent.click(r.getByRole("button", { name: "Open step: Pull" }));
    const sheet = document.querySelector('[data-component="StepEditSheet"]') as HTMLElement;
    expect(sheet.querySelector('[data-component="StepEditLocked"]')).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Save as a new revision" })).toBeNull();
    expect((within(sheet).getByDisplayValue("Pull") as HTMLInputElement).disabled).toBe(true);
  });

  it("a card edit while a proposal waits is a new proposal on the shown version, with Make active", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/projects/weekly/runs/8") return Promise.resolve(json(200, RUN));
      if (url === "/api/projects/weekly/playbook" && init?.method === "POST") {
        return Promise.resolve(json(200, { rev: 6, active: false }));
      }
      return Promise.resolve(json(200, { status: "idle", profiles: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const v5 = { ...rev(5, V4.map((s) => (s.key === "pull" ? { ...s, title: "Pull (2h)" } : s)), 0), base_rev: 4 };
    const pending = { active: rev(4, V4, 1), revisions: [v5, rev(4, V4, 1)] };
    const r = mount(pending);
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    expect(r.getByText("Revision 5 (proposed)")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Open step: Pull (2h)" }));
    const sheet = within(document.querySelector('[data-component="StepEditSheet"]') as HTMLElement);
    expect(sheet.getByText(/Saving proposes revision 6, based on revision 5/)).toBeTruthy();
    fireEvent.change(sheet.getByDisplayValue("Pull (2h)"), { target: { value: "Pull (3h)" } });
    fireEvent.click(sheet.getByRole("button", { name: "Save as a new revision" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls.find(([u, i]) => u === "/api/projects/weekly/playbook" && i?.method === "POST")!;
    const sent = JSON.parse(String(init!.body));
    expect(sent.base_rev).toBe(5);
    expect(sent.steps[0].title).toBe("Pull (3h)");

    // The refreshed list has v6 next to v5; the cards follow it, and the
    // confirmation leads with Make active — nothing was activated.
    const v6 = { ...rev(6, sent.steps, 0), base_rev: 5 };
    r.rerender(
      <PlanPanel
        slug="weekly"
        playbook={{ active: rev(4, V4, 1), revisions: [v6, v5, rev(4, V4, 1)] }}
        profiles={["ops", "finance"]}
        hostProfile="ops"
        canActivate
        archived={false}
        latestRunNo={8}
      />,
    );
    expect(r.getByText("Revision 6 (proposed)")).toBeTruthy();
    expect(r.getByText(/Saved as v6, a proposal based on v5/)).toBeTruthy();
    expect(r.getByRole("button", { name: "Make active" })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/activate"))).toBe(false);
    expect(r.container.querySelector('[data-component="RevisionPicker"] [data-rev="5"]')?.getAttribute("data-state")).toBe(
      "proposed",
    );
  });

  it("cards follow the version picked in the picker", () => {
    vi.stubGlobal("fetch", server());
    const v5 = { ...rev(5, [...V4, step("extra")], 0), base_rev: 4 };
    const r = mount({ active: rev(4, V4, 1), revisions: [v5, rev(4, V4, 1)] });
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    expect(r.container.querySelectorAll('[data-component="StepCard"]')).toHaveLength(V4.length + 1);
    fireEvent.click(r.container.querySelector('[data-component="RevisionPicker"] [data-rev="4"]')!);
    expect(r.getByText("Revision 4 (active)")).toBeTruthy();
    expect(r.container.querySelectorAll('[data-component="StepCard"]')).toHaveLength(V4.length);
  });

  it("marks the cards a version changed against the one before it, with its note", () => {
    vi.stubGlobal("fetch", server());
    const v4 = { ...rev(4, V4, 1), note: "first cut" };
    const v5Steps = [V4[0], { ...V4[1], body: "Use the NEW drive." }, V4[2], step("extra")];
    const v5 = {
      ...rev(5, v5Steps, 0),
      base_rev: 4,
      note: "finished workbooks from the NEW drive",
    };
    const v6 = { ...rev(6, v5Steps, 0), body: "Weekly digest, new wording.", base_rev: 5 };
    const r = mount({ active: v4, revisions: [v6, v5, v4] }, { latestRunNo: null });
    const tags = () =>
      Object.fromEntries(
        Array.from(r.container.querySelectorAll('[data-component="StepCard"]')).map((el) => [
          (el as HTMLElement).dataset.step,
          el.querySelector("[data-change]")?.textContent ?? null,
        ]),
      );
    const since = () => r.container.querySelector('[data-component="CardsSinceBase"]');
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    fireEvent.click(r.container.querySelector('[data-component="RevisionPicker"] [data-rev="5"]')!);
    expect(tags()).toEqual({ pull: null, clean: "Changed in v5", review: null, extra: "New in v5" });
    expect(since()?.textContent).toContain("v5 note: finished workbooks from the NEW drive");
    expect(since()?.textContent).toContain("Changed since v4: Clean, Extra.");

    // Same steps as v5: no card is marked, and the line says only the text changed.
    fireEvent.click(r.container.querySelector('[data-component="RevisionPicker"] [data-rev="6"]')!);
    expect(Object.values(tags()).every((tag) => tag == null)).toBe(true);
    expect(since()?.textContent).toContain("No step changed since v5; only the playbook text did.");

    // The Graph marks the same nodes.
    fireEvent.click(r.getByRole("button", { name: "Graph" }));
    fireEvent.click(r.container.querySelector('[data-component="RevisionPicker"] [data-rev="5"]')!);
    const node = r.container.querySelector('[data-component="StepNode"][data-step="clean"] [data-change]');
    expect(node?.textContent).toBe("Changed in v5");

    // The first version has nothing before it to compare with.
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    fireEvent.click(r.container.querySelector('[data-component="RevisionPicker"] [data-rev="4"]')!);
    // The first version has nothing to compare with, but its note still shows.
    expect(since()?.textContent).toBe("v4 note: first cut");
    expect(Object.values(tags()).every((tag) => tag == null)).toBe(true);
  });

  it("opens a step read-only for a viewer who can't propose changes", () => {
    vi.stubGlobal("fetch", server());
    const r = mount(ACTIVE_ONLY, { canPropose: false });
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    fireEvent.click(r.getByRole("button", { name: "Open step: Pull" }));
    const sheet = document.querySelector('[data-component="StepEditSheet"]') as HTMLElement;
    expect(within(sheet).getByText(/Only project members can change it/)).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Save as a new revision" })).toBeNull();
  });

  it("offers every assignable profile, not just the project's own", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/api/projects/weekly/assignable-profiles"
          ? Promise.resolve(
              json(200, {
                profiles: [
                  { name: "ops", in_project: true, is_host: true },
                  { name: "legal", in_project: false, is_host: false },
                ],
              }),
            )
          : server()(url),
      ),
    );
    const r = mount(ACTIVE_ONLY);
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    fireEvent.click(r.getByRole("button", { name: "Open step: Clean" }));
    const sheet = within(document.querySelector('[data-component="StepEditSheet"]') as HTMLElement);
    await waitFor(() => expect(sheet.getByRole("option", { name: "legal (not in project yet)" })).toBeTruthy());
    for (const name of ["ops", "finance"]) expect(sheet.getByRole("option", { name })).toBeTruthy();
  });

  it("shows a step changed since the latest run as Not run yet", async () => {
    vi.stubGlobal("fetch", server());
    const changed = V4.map((s) => (s.key === "pull" ? { ...s, title: "Pull two files" } : s));
    const r = mount({ active: rev(4, V4, 1), revisions: [rev(4, V4, 1), rev(5, changed, 0)] });
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    const lane = (name: string) =>
      r.container.querySelector(`[data-lane="${name}"]`) as HTMLElement;
    await waitFor(() => expect(within(lane("running")).getByText("Clean")).toBeTruthy());
    expect(within(lane("new")).getByText("Pull two files")).toBeTruthy();
  });

  it("gives every card control a 44px touch target", () => {
    vi.stubGlobal("fetch", server());
    const r = mount(ACTIVE_ONLY);
    fireEvent.click(r.getByRole("button", { name: "Kanban" }));
    const controls = r.container.querySelectorAll(
      '[data-component="PlaybookViewSwitch"] button, [data-component="LanesBySwitch"] button, [data-component="StepCard"]',
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c.className).toContain("min-h-11");
  });
});
