// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/digest",
  useRouter: () => router,
}));

import { RequirementsDoc } from "@/components/projects/requirements/RequirementsDoc";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import type {
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectPlaybookResponse,
} from "@/types";

function props(over: Partial<ProjectDetail> = {}): ProjectTabProps {
  const project = {
    slug: "digest",
    name: "Digest",
    goal: "Send the weekly sales digest.",
    description: "Charts posted to #sales.\nA person approves the email.",
    target_audience: "The finance list",
    links: {
      file: [
        {
          project_id: "p1",
          kind: "file",
          profile: "default",
          ref: "/data/sales_nov.xlsx",
          label: null,
          added_by: null,
          added_at: 1_790_000_000,
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
          added_at: 1_790_000_000,
        },
      ],
    },
    runs: [],
    ...over,
  } as unknown as ProjectDetail;
  const playbook = {
    active: { rev: 3 },
    revisions: [],
  } as unknown as ProjectPlaybookResponse;
  const directives = {
    directives: [],
    proposed: [
      {
        id: "d1",
        project_id: "p1",
        kind: "directive",
        body: "Leave out bounced addresses",
        scope: "project",
        target_ref: null,
        rating: null,
        author_user_id: "agent",
        created_at: 1_790_000_000,
        active: 0,
        retired_at: null,
        superseded_by: null,
      },
    ],
    applies_from: "next_run",
  } as ProjectDirectivesResponse;
  return {
    project,
    board: null,
    playbook,
    directives,
    doctor: null,
    callerUserId: "u1",
    canLead: true,
    readiness: [],
    runnable: true,
    onNavigate: vi.fn(),
    onChangeRequest: vi.fn(),
  };
}

function stubFetch(changes: { id: string; body: string; author_user_id: string; created_at: number }[] = []) {
  const posts: { url: string; body: unknown; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/changes")) {
        return new Response(JSON.stringify({ changes, runs: [] }), { status: 200 });
      }
      if (method !== "GET") {
        posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, method });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
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

describe("RequirementsDoc", () => {
  it("renders the doc: sections, source chips, version rail", async () => {
    stubFetch();
    render(<RequirementsDoc {...props()} />);
    expect(screen.getByText("Requirements")).toBeTruthy();
    // header pill + the "First draft" rail row both show v1
    expect(screen.getAllByText("v1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("First draft")).toBeTruthy();
    expect((screen.getByTestId("req-goal") as HTMLTextAreaElement).value).toBe(
      "Send the weekly sales digest.",
    );
    expect(screen.getByText("sales_nov.xlsx")).toBeTruthy();
    expect(screen.getByText("CRM · Q4 pipeline")).toBeTruthy();
    // proposed rule + accept/reject
    expect(screen.getByText(/Leave out bounced addresses/)).toBeTruthy();
    expect(screen.getByText("Accept")).toBeTruthy();
    // used-by footer mentions the active plan rev
    await waitFor(() => expect(screen.getByText(/Plan v3/)).toBeTruthy());
  });

  it("PATCHes only the edited fields and shows a pending version", async () => {
    const posts = stubFetch([{ id: "c1", body: "Added charts", author_user_id: "yan", created_at: 1_790_000_000 }]);
    render(<RequirementsDoc {...props()} />);
    // one landed change → current = v2, and the pending row appears once dirty
    await waitFor(() => expect(screen.getByText("v2")).toBeTruthy());
    fireEvent.change(screen.getByTestId("req-goal"), {
      target: { value: "Send the daily sales digest." },
    });
    await waitFor(() => expect(screen.getByText("v3")).toBeTruthy());
    fireEvent.click(screen.getByText("Save as v3"));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    const patch = posts.find((p) => p.method === "PATCH" && p.url.endsWith("/api/projects/digest"));
    expect(patch?.body).toEqual({ goal: "Send the daily sales digest." });
  });

  it("accepts an agent proposal via the activate endpoint", async () => {
    const posts = stubFetch();
    render(<RequirementsDoc {...props()} />);
    fireEvent.click(screen.getByText("Accept"));
    await waitFor(() =>
      expect(
        posts.some((p) => p.url.endsWith("/directives/d1/activate") && p.method === "POST"),
      ).toBeTruthy(),
    );
  });
});
