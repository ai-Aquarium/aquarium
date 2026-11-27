// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ComparePanel } from "@/components/projects/execution/ComparePanel";
import type { ProjectRun } from "@/types";

const run = (n: number, over: Partial<ProjectRun> = {}): ProjectRun => ({
  run_no: n,
  status: "done",
  playbook_rev: n === 6 ? 3 : 4,
  duration_seconds: n === 6 ? 1000 : 1200,
  cost: 0.4,
  score_user: n === 6 ? 4 : 5,
  score_self: 4,
  started_at: 1,
  cards: [],
  ...over,
} as ProjectRun);

function stubRuns() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = url.match(/runs\/(\d+)/);
      if (m) return new Response(JSON.stringify(run(Number(m[1]))), { status: 200 });
      return new Response("{}", { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ComparePanel", () => {
  it("shows meta rows, diffs tinted, swap and open links", async () => {
    stubRuns();
    render(<ComparePanel slug="digest" runNos={[6, 7]} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agent self-score")).toBeTruthy());
    expect(screen.getByText("v4 → v5".replace("v4 → v5", "Plan v3 → v4"))).toBeTruthy();
    // differing cells get the accent class
    const diff = screen.getAllByRole("cell").find((c) => c.getAttribute("data-differs"));
    expect(diff).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open R7" }).getAttribute("href")).toBe(
      "/projects/digest/runs/7",
    );
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open R6" })).toBeTruthy(),
    );
  });
});
