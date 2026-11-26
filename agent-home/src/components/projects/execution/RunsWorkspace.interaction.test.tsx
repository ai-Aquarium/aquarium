// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/monday-digest",
  useRouter: () => router,
}));
vi.mock("@/components/projects/useRunLive", () => ({ useRunLive: () => undefined }));

import { RunsWorkspace } from "@/components/projects/execution/RunsWorkspace";
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
let artifacts: unknown[] = [];

function setup(runs: ProjectRunBrief[], extra: Partial<ProjectTabProps> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/runs")) {
      return history
        ? new Response(JSON.stringify({ runs: history }), { status: 200 })
        : new Response("{}", { status: 503 });
    }
    if (url.includes("/artifacts")) {
      return new Response(JSON.stringify(artifacts), { status: 200 });
    }
    const action = /\/runs\/(\d+)\/(continue|cancel|stop)$/.exec(url);
    if (action && init?.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (/\/cards\/[^/]+\/approvals$/.test(url) && init?.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
    project: { slug: SLUG, runs, archived: false, outputs: [] },
    board: null,
    ...extra,
  } as unknown as ProjectTabProps;
  render(<RunsWorkspace {...props} />);
  return fetchMock;
}

afterEach(() => {
  history = null;
  detailOver = {};
  artifacts = [];
  cleanup();
  vi.unstubAllGlobals();
});

describe("RunsWorkspace", () => {
  it("lists runs in the rail and leads with the live run's detail", async () => {
    setup([brief(4), brief(5, { status: "waiting", ended_at: null })]);
    const rail = screen.getByRole("complementary", { name: "Run list" });
    expect(within(rail).getByText("R5")).toBeTruthy();
    expect(within(rail).getByText("R4")).toBeTruthy();
    // The waiting run is selected by default; its cards and Continue load.
    const detail_ = await screen.findByRole("region", { name: /R5/ });
    await waitFor(() =>
      expect(detail_.querySelectorAll('[data-component="RunStep"]')).toHaveLength(2),
    );
    const states = [...detail_.querySelectorAll('[data-component="RunStep"]')].map(
      (el) => el.getAttribute("data-state"),
    );
    expect(states).toEqual(["done", "needs"]);
    expect(within(detail_).getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(within(detail_).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(within(detail_).getByRole("button", { name: "Stop" })).toBeTruthy();
    // The rail row for the selected run carries the selected marker.
    expect(rail.querySelector('[data-run="5"]')).toBeTruthy();
    expect(rail.querySelector('[data-selected="true"]')).toBeTruthy();
  });

  it("selecting a rail row swaps the detail", async () => {
    setup([brief(4), brief(5)]);
    await screen.findByRole("region", { name: /R5/ });
    const rail = screen.getByRole("complementary", { name: "Run list" });
    fireEvent.click(within(rail).getByRole("button", { name: /R4/ }));
    const detail_ = await screen.findByRole("region", { name: /R4/ });
    await waitFor(() =>
      expect(detail_.querySelectorAll('[data-component="RunStep"]')).toHaveLength(2),
    );
  });

  it("shows the inline approval under a waiting card and posts the decision", async () => {
    const waiting = brief(5, { status: "waiting", ended_at: null });
    detailOver = {
      waiting_on_you: [
        { task_id: "a5", title: "Owner reviews", block_kind: "needs_input", reason: "Send the digest to 32 people?" },
      ],
    };
    const fetchMock = setup([waiting], {
      board: {
        columns: [
          {
            name: "blocked",
            tasks: [
              {
                id: "a5",
                title: "Owner reviews",
                status: "blocked",
                pending_approvals: [
                  { key: "send:email:1", label: "send email", detail: "send\n{\"user_intent\":\"Mail the digest\"}", requested_at: 1 },
                ],
              },
            ],
          },
        ],
      } as never,
    });
    const box = await screen.findByText("Approval needed");
    const approval = box.closest('[data-component="InlineApproval"]') as HTMLElement;
    expect(within(approval).getByText("Send the digest to 32 people?")).toBeTruthy();
    expect(within(approval).getByText(/Mail the digest/)).toBeTruthy();
    fireEvent.click(within(approval).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          /\/cards\/a5\/approvals$/.test(String(url)) &&
            (init as RequestInit)?.method === "POST" &&
            String((init as RequestInit).body).includes('"decision":"approve"'),
        ),
      ).toBe(true),
    );
  });

  it("grades a finished run with stars and offers compare-with-previous", async () => {
    const fetchMock = setup([brief(4), brief(5)]);
    const detail_ = await screen.findByRole("region", { name: /R5/ });
    await waitFor(() => expect(detail_.querySelector('[data-component="RunGrade"]')).toBeTruthy());
    fireEvent.click(within(detail_).getAllByRole("button", { name: "4" })[0]);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          /\/runs\/5\/score$/.test(String(url)) &&
            String((init as RequestInit)?.body).includes('"score":4'),
        ),
      ).toBe(true),
    );
    fireEvent.click(within(detail_).getByRole("button", { name: "Compare with R4" }));
    expect(await screen.findByRole("region", { name: /Compare runs 4, 5/ })).toBeTruthy();
  });

  it("ticking two rail rows enables the side-by-side compare", async () => {
    setup([brief(4), brief(5), brief(6)]);
    await screen.findByRole("region", { name: /R6/ });
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare run 4" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare run 6" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByRole("region", { name: /Compare runs 4, 6/ })).toBeTruthy();
  });

  it("shows only the selected run's outputs as tiles", async () => {
    artifacts = [
      { id: "f1", title: "summary.pdf", kind: "file", ext: "pdf", href: "/api/x/f1/content", run_no: 5, missing: false },
      { id: "f2", title: "old.csv", kind: "file", ext: "csv", href: "/api/x/f2/content", run_no: 4, missing: false },
    ];
    setup([brief(4), brief(5)]);
    const detail_ = await screen.findByRole("region", { name: /R5/ });
    await waitFor(() =>
      expect(detail_.querySelectorAll('[data-component="RunOutputTile"]')).toHaveLength(1),
    );
    expect(within(detail_).getByText("summary.pdf")).toBeTruthy();
    expect(within(detail_).queryByText("old.csv")).toBeNull();
  });

  it("pauses a live run through the real action endpoint", async () => {
    const fetchMock = setup([brief(5, { status: "running", ended_at: null })]);
    const detail_ = await screen.findByRole("region", { name: /R5/ });
    fireEvent.click(within(detail_).getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          /\/runs\/5\/cancel$/.test(String(url)) && (init as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
  });
});
