// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/digest",
  useRouter: () => router,
}));

import { PlanStep } from "@/components/projects/plan/PlanStep";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import type { PlaybookRev, ProjectDetail, ProjectPlaybookResponse } from "@/types";

const rev = (n: number, over: Partial<PlaybookRev> = {}): PlaybookRev => ({
  project_id: "p1",
  rev: n,
  body: "plan",
  steps: [
    { key: "pull", title: "Pull the sales", body: "From the CRM.", assignee: "Data analyst", assignee_reason: "Has CRM access" },
    { key: "mail", title: "Email the digest", checkpoint: true, assignee: "Mailer" },
  ],
  active: n === 3 ? 1 : 0,
  created_by: "agent",
  created_at: 1_789_000_000,
  activated_at: 1_789_500_000,
  note: n === 3 ? "Reworded step 4" : null,
  ...over,
});

const PLAYBOOK: ProjectPlaybookResponse = {
  active: rev(3),
  revisions: [rev(3), rev(2)],
};

function props(over: Partial<ProjectTabProps> = {}): ProjectTabProps {
  return {
    project: {
      slug: "digest",
      name: "Digest",
      members: [],
      profiles: [],
      runs: [],
    } as unknown as ProjectDetail,
    board: null,
    playbook: PLAYBOOK,
    directives: null,
    doctor: null,
    callerUserId: "u1",
    canLead: true,
    readiness: [],
    runnable: true,
    onNavigate: vi.fn(),
    onChangeRequest: vi.fn(),
    ...over,
  };
}

function stubChanges(changes: unknown[] = [], runs: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/changes")) {
        return new Response(JSON.stringify({ changes, runs }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PlanStep", () => {
  it("renders the toolbar, step rows with why/approval, and the rail", async () => {
    stubChanges();
    render(<PlanStep {...props()} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    // step rows: title, body, assignee pill, why, needs-approval
    expect(screen.getByText("Pull the sales")).toBeTruthy();
    expect(screen.getByText("Data analyst")).toBeTruthy();
    expect(screen.getByText(/Why: Has CRM access/)).toBeTruthy();
    expect(screen.getByText("Needs approval")).toBeTruthy();
    // rail: v3 Current (header pill + rail row both render it), v2
    expect(screen.getAllByText("v3").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Reworded step 4/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Versions")).toBeTruthy());
  });

  it("switches to the v2 → v3 diff", async () => {
    stubChanges();
    render(<PlanStep {...props()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Diff v2 → v3/ }));
    await waitFor(() =>
      expect(screen.getByText(/The plan stays the same|added|changed|removed/)).toBeTruthy(),
    );
  });

  it("shows the out-of-date banner when requirements changed after activation", async () => {
    stubChanges(
      [{ id: "c1", body: "New rule", author_user_id: "yan", created_at: 1_800_000_000 }],
      [{ run_no: 6, playbook_rev: 3 }, { run_no: 7, playbook_rev: 3 }],
    );
    render(<PlanStep {...props()} />);
    await waitFor(() => expect(screen.getByTestId("plan-stale-banner")).toBeTruthy());
    // USED BY groups runs by pinned rev
    await waitFor(() => expect(screen.getByText(/R6, R7 used v3/)).toBeTruthy());
  });
});
