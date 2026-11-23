// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/monday-digest",
  useRouter: () => router,
}));
vi.mock("@/components/projects/useRunLive", () => ({ useRunLive: () => undefined }));

import { ExecutionRuns } from "@/components/projects/execution/ExecutionRuns";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import type { ProjectRun, ProjectRunBrief } from "@/types";

const SLUG = "monday-digest";

const brief = (run_no: number, over: Partial<ProjectRunBrief> = {}): ProjectRunBrief => ({
  run_no,
  status: "done",
  trigger: "manual",
  started_at: 1_790_000_000 + run_no * 3600,
  ended_at: 1_790_000_000 + run_no * 3600 + 900,
  duration_seconds: 900,
  outcome: null,
  score_user: null,
  playbook_rev: run_no > 2 ? 2 : 1,
  ...over,
});

function detail(b: ProjectRunBrief): ProjectRun {
  return {
    ...b,
    id: `r${b.run_no}`,
    project_id: "p1",
    triggered_by: null,
    profile: "default",
    playbook_rev: b.playbook_rev ?? null,
    session_id: null,
    trace_id: null,
    summary: null,
    retro: `retro ${b.run_no}`,
    retro_at: null,
    score_self: null,
    score_note: null,
    scored_by: null,
    scored_at: null,
    error: null,
    cost: 0.5,
    completion_percent: b.status === "done" ? 100 : 50,
    cards: [
      { task_id: `g${b.run_no}`, step_key: "gather", status: "done", title: "Collect arrivals", started_at: 0, completed_at: 60 * b.run_no },
      {
        task_id: `a${b.run_no}`,
        step_key: "approve",
        status: b.status === "waiting" ? "blocked" : "done",
        title: "Owner reviews",
      },
    ],
    waiting_on_you: [],
  } as ProjectRun;
}

let history: ProjectRunBrief[] | null = null;
let detailOver: Partial<ProjectRun> = {};

function setup(runs: ProjectRunBrief[], extra: Partial<ProjectTabProps> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/runs")) {
      return history
        ? new Response(JSON.stringify({ runs: history }), { status: 200 })
        : new Response("{}", { status: 503 });
    }
    const m = /\/runs\/(\d+)(\/score)?$/.exec(url);
    if (m && m[2] && init?.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const b = [...runs, ...(history ?? [])].find((r) => r.run_no === Number(m?.[1]));
    return new Response(JSON.stringify(b ? { ...detail(b), ...detailOver } : {}), {
      status: b ? 200 : 404,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const props = {
    project: { slug: SLUG, runs, archived: false },
    ...extra,
  } as unknown as ProjectTabProps;
  render(<ExecutionRuns {...props} />);
  return fetchMock;
}

afterEach(() => {
  history = null;
  detailOver = {};
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExecutionRuns", () => {
  it("leads with the live run and shows each card's state", async () => {
    setup([brief(4), brief(5, { status: "waiting", ended_at: null })]);
    const current = await screen.findByRole("region", { name: "Current run" });
    expect(within(current).getByText("Run 5")).toBeTruthy();
    await waitFor(() =>
      expect(current.querySelectorAll('[data-component="CurrentRunCard"]')).toHaveLength(2),
    );
    const states = [...current.querySelectorAll('[data-component="CurrentRunCard"]')].map(
      (el) => el.getAttribute("data-state"),
    );
    expect(states).toEqual(["done", "needs"]);
    expect(within(current).getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("lists every run in a table with version, status, duration and 1–5 score", () => {
    setup([brief(1, { score_user: 2 }), brief(2), brief(3, { score_user: 4 })]);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("#3")).toBeTruthy();
    expect(within(rows[0]).getAllByText("v2").length).toBeGreaterThan(0);
    expect(within(rows[0]).getByText("4/5")).toBeTruthy();
    expect(within(rows[0]).getByText("15m")).toBeTruthy();
  });

  it("compares 2–3 runs side by side and caps the pick at three", async () => {
    setup([1, 2, 3, 4].map((n) => brief(n)));
    const compare = screen.getByRole("button", { name: /Compare 2 runs/ });
    expect((compare as HTMLButtonElement).disabled).toBe(true);
    for (const n of [2, 3, 4]) fireEvent.click(screen.getByLabelText(`Compare run ${n}`));
    expect((screen.getByLabelText("Compare run 1") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Compare 3 runs/ }));
    const panel = await screen.findByRole("region", { name: "Compare runs 2, 3, 4" });
    await waitFor(() =>
      expect(panel.querySelectorAll('[data-component="CompareStep"]')).toHaveLength(2),
    );
    // The gather step took longest in run 4: flagged once, in that column.
    const gather = panel.querySelector<HTMLElement>('[data-component="CompareStep"]')!;
    const slow = gather.querySelectorAll("[data-slowest]");
    expect(slow).toHaveLength(1);
    expect(within(gather).getAllByRole("cell").indexOf(slow[0] as HTMLElement)).toBe(2);
    expect(within(panel).getByText("retro 3")).toBeTruthy();
  });

  it("hands a comparison summary to the project chat", async () => {
    const onDiscussInChat = vi.fn();
    setup([brief(1, { score_user: 3 }), brief(2, { score_user: 5 })], { onDiscussInChat });
    fireEvent.click(screen.getByLabelText("Compare run 1"));
    fireEvent.click(screen.getByLabelText("Compare run 2"));
    fireEvent.click(screen.getByRole("button", { name: /Compare 2 runs/ }));
    const discuss = await screen.findByRole("button", { name: "Discuss in chat" });
    await waitFor(() => expect((discuss as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(discuss);
    expect(onDiscussInChat).toHaveBeenCalledTimes(1);
    const text = onDiscussInChat.mock.calls[0][0] as string;
    expect(text).toContain("Run 1");
    expect(text).toContain("score 5/5");
  });

  it("scores the finished current run 1–5 through the existing score route", async () => {
    // Re-scoring keeps the saved note: the route overwrites both.
    detailOver = { score_note: "tight" };
    const fetchMock = setup([brief(1)]);
    const group = await screen.findByRole("group", { name: "Score run 1 from 1 to 5" });
    fireEvent.click(within(group).getByRole("button", { name: "4" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/runs/1/score"));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ score: 4, note: "tight" });
    });
    await waitFor(() =>
      expect(within(group).getByRole("button", { name: "4" }).getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("re-scoring sends the note as saved now, not as first loaded", async () => {
    detailOver = { score_note: "tight" };
    const fetchMock = setup([brief(1)]);
    const group = await screen.findByRole("group", { name: "Score run 1 from 1 to 5" });
    // The note is cleared on the run page while this view stays mounted.
    detailOver = { score_note: null };
    fireEvent.click(within(group).getByRole("button", { name: "2" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/runs/1/score"));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ score: 2 });
    });
  });

  it("offers Continue while a running run is held at a supervised checkpoint", async () => {
    detailOver = { status: "running", awaiting_continue: true };
    setup([brief(2, { status: "running", ended_at: null })]);
    const current = await screen.findByRole("region", { name: "Current run" });
    expect(await within(current).findByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("lists runs older than the project read's recent window from the run record", async () => {
    history = [1, 2, 3, 4, 5, 6, 7].map((n) => brief(n, { score_user: 3 }));
    setup([3, 4, 5, 6, 7].map((n) => brief(n)));
    const table = screen.getByRole("table");
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1)).toHaveLength(7));
    expect(within(table).getByText("#1")).toBeTruthy();
  });

  it("shows the trend only from scored runs", () => {
    setup([brief(1), brief(2)]);
    const trend = screen.getByRole("region", { name: "Score trend" });
    expect(within(trend).queryByRole("img")).toBeNull();
  });
});
