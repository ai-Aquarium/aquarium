import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/components/projects/outputs/LatestOutputsShelf", () => ({ LatestOutputsShelf: () => null }));

import { ProjectDetailView } from "@/components/projects/ProjectDetailView";
import { board, playbook, project } from "@/components/projects/dashboard/__fixtures__/dashboard";
import type { ClarifySummary, ProjectDetail } from "@/types";

function scopeStep(p: ProjectDetail): string {
  const html = renderToStaticMarkup(
    <ProjectDetailView
      project={p}
      board={board()}
      playbook={playbook()}
      directives={null}
      callerUserId="yan"
      isInstanceAdmin={false}
    />,
  );
  const match = html.match(/<button[^>]*data-step="requirements"[^>]*>([\s\S]*?)<\/button>/);
  expect(match).not.toBeNull();
  return match![1];
}

const summary = (over: Partial<ClarifySummary>): ClarifySummary => ({
  status: "open",
  round: 1,
  open_count: 0,
  answered_count: 0,
  understanding: null,
  confirmed_at: null,
  ...over,
});

describe("ProjectDetailView — Requirements step warn (open scope questions)", () => {
  it("shows how many scope questions are open", () => {
    const step = scopeStep(project({ clarify: summary({ open_count: 3 }) }));
    expect(step).toContain("data-warn");
    expect(step).toContain("3 open questions");
  });

  it("shows no warn with nothing open, or on an older server without clarify", () => {
    for (const p of [
      project({ clarify: summary({ status: "answered", open_count: 0 }) }),
      project(),
      project({ clarify: null }),
    ]) {
      const step = scopeStep(p);
      expect(step).not.toContain("data-warn");
      expect(step).not.toContain("open questions");
    }
  });
});
