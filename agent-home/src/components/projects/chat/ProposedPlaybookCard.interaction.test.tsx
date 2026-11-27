// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ProposedPlaybookCard } from "@/components/projects/chat/ProjectChatPanel";
import type { ProjectChatProposal } from "@/types";

const proposal: ProjectChatProposal = {
  rev: 5,
  base_rev: 4,
  active: false,
  created_at: 100,
  created_by: "research",
  note: null,
  added: 1,
  removed: 0,
  changed: 2,
  added_titles: ["Flag outliers"],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProposedPlaybookCard", () => {
  it("summarises the change and links to the review", () => {
    const r = render(<ProposedPlaybookCard slug="digest" proposal={proposal} />);
    expect(r.getByText("Playbook v5")).toBeTruthy();
    expect(r.getByText("Proposed")).toBeTruthy();
    expect(r.container.textContent).toContain("+1 steps (Flag outliers) · 2 changed");
    expect(r.getByText("v4 → v5")).toBeTruthy();
    const editFirst = r.getByRole("link", { name: "Edit first" });
    expect(editFirst.getAttribute("href")).toBe("/projects/digest?tab=plan&rev=5");
  });

  it("makes the revision active through the project action route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rev: 5, active: true })));
    vi.stubGlobal("fetch", fetchMock);
    const r = render(<ProposedPlaybookCard slug="digest" proposal={proposal} />);
    fireEvent.click(r.getByRole("button", { name: "Save as v5" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/digest/playbook/5/activate");
    expect(init.method).toBe("POST");
  });

  it("has no activate button once the revision is active", () => {
    const r = render(<ProposedPlaybookCard slug="digest" proposal={{ ...proposal, active: true }} />);
    expect(r.getByText("Active")).toBeTruthy();
    expect(r.queryByRole("button", { name: "Save as v5" })).toBeNull();
  });

  it("discards the revision through the DELETE route", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const r = render(<ProposedPlaybookCard slug="digest" proposal={proposal} />);
    fireEvent.click(r.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/digest/playbook/5");
    expect(init.method).toBe("DELETE");
  });
});
