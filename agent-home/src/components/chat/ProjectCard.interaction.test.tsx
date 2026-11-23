// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectCard } from "@/components/chat/ProjectCard";

type Call = [string, RequestInit | undefined];

function api(project: Record<string, unknown>, revisions = [{ rev: 1, active: false }]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (url === "/api/projects/weekly-sales") {
      if (init?.method === "PATCH") return new Response(JSON.stringify({ status: "active" }));
      return new Response(JSON.stringify(project));
    }
    if (url === "/api/projects/weekly-sales/playbook") {
      return new Response(JSON.stringify({ active: null, revisions }));
    }
    if (url.endsWith("/activate")) return new Response(JSON.stringify({ rev: 1, active: true }));
    if (url.endsWith("/runs")) return new Response(JSON.stringify({ run_no: 1 }));
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const lead = { name: "Weekly sales report", ref: "P12", status: "planning", can_write: true, runs: [] };
const card = { slug: "weekly-sales", ref: "P12", quoted: true };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectCard", () => {
  it("shows the project, its proposed v1 and where Open project lands", async () => {
    api(lead);
    const r = render(<ProjectCard card={card} />);
    await waitFor(() => expect(r.getByText("Weekly sales report")).toBeTruthy());
    expect(r.getByText("P12")).toBeTruthy();
    expect(r.getByText("Playbook v1 proposed")).toBeTruthy();
    expect(r.container.textContent).toContain("project members can read it");
    expect(r.getByRole("link", { name: "Open project" }).getAttribute("href")).toBe(
      "/projects/weekly-sales?tab=planning&chat=open&rev=1",
    );
  });

  it("makes v1 active, opens the project and starts run 1 on click, never before", async () => {
    const calls = api(lead);
    const r = render(<ProjectCard card={card} />);
    const button = await r.findByRole("button", { name: "Make v1 active & run 1" });
    expect(calls.map(([u, i]) => `${i?.method ?? "GET"} ${u}`)).toEqual([
      "GET /api/projects/weekly-sales",
      "GET /api/projects/weekly-sales/playbook",
    ]);
    fireEvent.click(button);
    await waitFor(() => expect(r.getByText("Run 1 started")).toBeTruthy());
    expect(calls.slice(2).map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      "POST /api/projects/weekly-sales/playbook/1/activate",
      "PATCH /api/projects/weekly-sales",
      "POST /api/projects/weekly-sales/runs",
    ]);
    expect(JSON.parse(String(calls[4][1]?.body))).toEqual({ playbook_rev: 1 });
  });

  it("offers no Make active to someone who can't", async () => {
    api({ ...lead, can_write: false });
    const r = render(<ProjectCard card={{ ...card, quoted: false }} />);
    await waitFor(() => expect(r.getByText("Playbook v1 proposed")).toBeTruthy());
    expect(r.queryByRole("button")).toBeNull();
    expect(r.container.textContent).not.toContain("project members can read it");
  });

  it.each([
    ["after a run", { ...lead, status: "active", runs: [{ run_no: 1 }] }],
    ["when paused", { ...lead, status: "paused" }],
  ])("only opens the project %s", async (_when, project) => {
    api(project, [{ rev: 1, active: true }, { rev: 2, active: false }] as never);
    const r = render(<ProjectCard card={card} />);
    await waitFor(() => expect(r.getByText("Playbook v2 proposed")).toBeTruthy());
    expect(r.queryByRole("button")).toBeNull();
    expect(r.getByRole("link", { name: "Open project" })).toBeTruthy();
  });

  it("stops at the first refused step", async () => {
    const calls = api(lead);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/activate")) {
          return new Response(JSON.stringify({ detail: "only a lead can" }), { status: 403 });
        }
        if (url.endsWith("/playbook")) {
          return new Response(JSON.stringify({ active: null, revisions: [{ rev: 1, active: false }] }));
        }
        return new Response(JSON.stringify(lead));
      }),
    );
    const r = render(<ProjectCard card={card} />);
    fireEvent.click(await r.findByRole("button", { name: "Make v1 active & run 1" }));
    await waitFor(() => expect(r.getByRole("alert")).toBeTruthy());
    expect(calls.some(([u]) => u.endsWith("/runs"))).toBe(false);
  });
});
