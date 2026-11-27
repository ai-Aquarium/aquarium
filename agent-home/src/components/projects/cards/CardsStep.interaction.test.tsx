// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/digest",
  useRouter: () => router,
}));

import { CardsStep } from "@/components/projects/cards/CardsStep";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import type {
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectPlaybookResponse,
} from "@/types";

const task = (over: Partial<ProjectBoardTask> = {}): ProjectBoardTask => ({
  id: "t1",
  ref: "T1",
  title: "Pull the sales",
  body: "Query the CRM and pull rows.",
  status: "ready",
  assignee: "Data analyst",
  priority: 0,
  created_at: 1,
  started_at: null,
  completed_at: null,
  tenant: null,
  project_id: "p1",
  result: null,
  current_step_key: "pull",
  assignment: { assignee_reason: "Has CRM access", assigned_by: "planner" },
  ...over,
});

const BOARD: ProjectBoardView = {
  columns: [
    {
      name: "open",
      tasks: [
        task(),
        task({
          id: "t2",
          ref: "T2",
          title: "Email the digest",
          status: "blocked",
          current_step_key: "mail",
          pending_approvals: [{ id: "a1" } as never],
        }),
        task({ id: "t3", ref: "T3", title: "Old done card", status: "done", current_step_key: null }),
      ],
    },
  ],
};

const PLAYBOOK: ProjectPlaybookResponse = {
  active: {
    project_id: "p1",
    rev: 3,
    body: "plan",
    steps: [
      { key: "pull", title: "Pull", depends_on: [] },
      { key: "mail", title: "Mail", depends_on: ["pull"] },
    ],
    active: 1,
    created_by: "agent",
    created_at: 1,
    activated_at: 1,
    note: null,
  },
  revisions: [],
};

function props(over: Partial<ProjectTabProps> = {}): ProjectTabProps {
  return {
    project: {
      slug: "digest",
      name: "Digest",
      members: [],
      profiles: [],
      runs: [{ run_no: 7, status: "running" }],
    } as unknown as ProjectDetail,
    board: BOARD,
    playbook: PLAYBOOK,
    directives: null,
    doctor: null,
    callerUserId: "u1",
    canLead: true,
    readiness: [],
    runnable: true,
    onNavigate: vi.fn(),
    onChangeRequest: vi.fn(),
    onDiscussInChat: vi.fn(),
    ...over,
  };
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CardsStep", () => {
  it("renders the toolbar, kanban lanes, and card tiles", () => {
    stubFetch();
    render(<CardsStep {...props()} />);
    expect(screen.getByTestId("cards-kanban")).toBeTruthy();
    expect(screen.getByText(/From Plan v3 · status from R7/)).toBeTruthy();
    expect(screen.getByText(/Ready 1/)).toBeTruthy();
    expect(screen.getByText(/Needs you 1/)).toBeTruthy();
    expect(screen.getByText(/Done 1/)).toBeTruthy();
    expect(screen.getByText("Pull the sales")).toBeTruthy();
    expect(screen.getAllByText("Auto").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Pull the sales"));
    expect(screen.getByText(/Has CRM access/)).toBeTruthy();
  });

  it("opens the detail panel on card click and asks the agent", () => {
    stubFetch();
    const p = props();
    render(<CardsStep {...p} />);
    fireEvent.click(screen.getByText("Email the digest"));
    expect(screen.getByText("Needs approval")).toBeTruthy();
    expect(screen.getByText("Query the CRM", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));
    expect(p.onDiscussInChat).toHaveBeenCalledWith(
      expect.stringContaining("Email the digest"),
    );
  });

  it("switches to the graph view with dependency edges and zoom", async () => {
    stubFetch();
    render(<CardsStep {...props()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    const graph = screen.getByTestId("cards-graph");
    expect(graph.querySelectorAll("line").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(screen.getByText("110%")).toBeTruthy());
  });

  it("creates a card via the add-card form", async () => {
    stubFetch();
    const fetchMock = vi.mocked(fetch);
    render(<CardsStep {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Card" }));
    fireEvent.change(screen.getByPlaceholderText("Card title…"), {
      target: { value: "New card" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Add" }).closest("form")!,
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/digest/cards",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
