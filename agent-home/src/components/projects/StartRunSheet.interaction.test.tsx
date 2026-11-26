// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/digest",
  useRouter: () => router,
}));

import { StartRunSheet } from "@/components/projects/StartRunSheet";
import type {
  PlaybookRev,
  ProjectDetail,
  ProjectPlaybookResponse,
  ProjectRunBrief,
} from "@/types";

const SLUG = "digest";

const run = (run_no: number, over: Partial<ProjectRunBrief> = {}): ProjectRunBrief => ({
  run_no,
  status: "done",
  trigger: "manual",
  started_at: 1_790_000_000 + run_no * 3600,
  ended_at: 1_790_000_000 + run_no * 3600 + 600,
  duration_seconds: 600,
  outcome: null,
  score_user: null,
  ...over,
});

const rev = (n: number, over: Partial<PlaybookRev> = {}): PlaybookRev => ({
  project_id: "p1",
  rev: n,
  body: "plan",
  steps: [
    { key: "collect", title: "Collect" },
    { key: "review", title: "Review", checkpoint: true },
  ],
  active: n === 3 ? 1 : 0,
  created_by: null,
  created_at: 1_789_000_000,
  activated_at: n === 3 ? 1_789_500_000 : null,
  note: null,
  ...over,
});

const PLAYBOOK: ProjectPlaybookResponse = {
  active: rev(3),
  revisions: [rev(2), rev(3)],
};

function project(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    slug: SLUG,
    name: "Digest",
    links: {
      file: [
        {
          project_id: "p1",
          kind: "file",
          profile: "default",
          ref: "/data/sales_nov.xlsx",
          label: null,
          added_by: null,
          added_at: 1_790_010_000 + 3600, // after R1 started → "new since"
        },
      ],
      url: [
        {
          project_id: "p1",
          kind: "url",
          profile: "default",
          ref: "https://crm.example/pipeline",
          label: "CRM · Q4 pipeline",
          added_by: null,
          added_at: 1_789_000_000,
        },
      ],
    },
    runs: [run(1), run(2)],
    ...over,
  } as unknown as ProjectDetail;
}

function stubFetch(runs: ProjectRunBrief[] = project().runs) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url === `/api/projects/${SLUG}/runs`) {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ run_no: 3 }), { status: 200 });
      }
      if (url === `/api/projects/${SLUG}/runs`) {
        return new Response(JSON.stringify({ runs }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StartRunSheet", () => {
  it("renders the mockup fields: versions, batch inputs, estimate", async () => {
    stubFetch();
    render(
      <StartRunSheet
        project={project()}
        playbook={PLAYBOOK}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Start a new run")).toBeTruthy();
    const select = screen.getByTestId("start-run-rev") as HTMLSelectElement;
    expect(select.value).toBe("3"); // active rev preselected
    expect(screen.getByText(/2 steps/)).toBeTruthy();
    // batch row: 2 inputs, 1 new since R2
    expect(screen.getByText(/2 inputs/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/new since R2/)).toBeTruthy(),
    );
    // chips
    expect(screen.getByText("sales_nov.xlsx")).toBeTruthy();
    expect(screen.getByText("CRM · Q4 pipeline")).toBeTruthy();
    // estimate: 600s runs → 8–12 min range, 1 checkpoint approval
    expect(screen.getByText(/8m–12m|8 min–12 min|10m/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/will ask for your approval/)).toBeTruthy(),
    );
  });

  it("posts playbook_rev for the chosen version", async () => {
    const posts = stubFetch();
    const onClose = vi.fn();
    const onStarted = vi.fn();
    render(
      <StartRunSheet
        project={project()}
        playbook={PLAYBOOK}
        onClose={onClose}
        onStarted={onStarted}
      />,
    );
    fireEvent.change(screen.getByTestId("start-run-rev"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByText("Start run", { selector: "button" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ playbook_rev: 2 });
    expect(onStarted).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the first-run estimate line with no history", async () => {
    stubFetch([]);
    render(
      <StartRunSheet
        project={project({ runs: [] })}
        playbook={PLAYBOOK}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/no estimate yet/i)).toBeTruthy(),
    );
  });
});
