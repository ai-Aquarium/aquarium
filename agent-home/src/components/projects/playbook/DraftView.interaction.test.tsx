// @vitest-environment jsdom
/**
 * Phase 8: co-create the playbook. Each member's working draft sits next to
 * the versions, highlighted against its base; its owner saves it as a
 * proposal, a viewer only reads it, and "Ask about this" quotes into chat.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/weekly",
  useRouter: () => router,
}));

import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import type { PlaybookDraft, PlaybookRev, ProjectPlaybookResponse } from "@/types";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const V5: PlaybookRev = {
  project_id: "p",
  rev: 5,
  body: "Every Monday, build the report.\nDedupe rows.",
  steps: [
    { key: "pull", title: "Pull the CRM export", depends_on: [] },
    { key: "send", title: "Email the PDF", depends_on: ["pull"] },
  ],
  active: 1,
  created_by: "leo",
  created_at: 5,
  activated_at: 5,
  note: null,
};
const PLAYBOOK: ProjectPlaybookResponse = { active: V5, revisions: [V5] };

const draft = (extra: Partial<PlaybookDraft> = {}): PlaybookDraft => ({
  project_id: "p",
  user_id: "leo",
  base_rev: 5,
  body: "Every Monday, build the report.\nIf the export is late, wait until 10:45.\nDedupe rows.",
  steps: [
    { key: "wait", title: "Wait for the CRM export", depends_on: [] },
    { key: "pull", title: "Pull the CRM export", depends_on: ["wait"] },
    { key: "send", title: "Email the PDF", depends_on: ["pull"] },
  ],
  note: null,
  updated_by: "agent",
  version: 3,
  created_at: 10,
  updated_at: 20,
  mine: true,
  can_edit: true,
  can_discard: true,
  ...extra,
});

function server(drafts: PlaybookDraft[]) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/projects/weekly/playbook/drafts") {
      return Promise.resolve(json(200, { drafts, me: "leo", can_draft: true }));
    }
    if (url === "/api/projects/weekly/playbook/drafts/me/save" && init?.method === "POST") {
      return Promise.resolve(json(200, { rev: 6, active: false, base_rev: 5 }));
    }
    return Promise.resolve(json(200, { status: "idle", profiles: [] }));
  });
}

function mount(onAsk = vi.fn(), extra: { canPropose?: boolean; callerUserId?: string } = {}) {
  render(
    <PlanPanel
      slug="weekly"
      playbook={PLAYBOOK}
      profiles={["ops"]}
      hostProfile="ops"
      canActivate={false}
      canPropose={extra.canPropose ?? true}
      callerUserId={extra.callerUserId ?? "leo"}
      archived={false}
      onAsk={onAsk}
    />,
  );
  return onAsk;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("working drafts in Planning", () => {
  it("opens the caller's draft, labelled by owner and base, with its changes marked", async () => {
    vi.stubGlobal("fetch", server([draft()]));
    mount();
    const draftView = await waitFor(() => {
      const el = document.querySelector('[data-component="PlaybookDraft"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(document.querySelector('[data-draft="leo"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(within(draftView).getAllByText(/Draft · leo \(from v5\)/).length).toBeGreaterThan(0);
    const changed = draftView.querySelectorAll('[data-paragraph][data-changed="true"]');
    expect([...changed].map((p) => p.textContent)).toEqual(["If the export is late, wait until 10:45."]);
    expect(draftView.querySelector('[data-step="wait"]')?.getAttribute("data-change")).toBe("added");
    expect(draftView.querySelector('[data-step="pull"]')?.getAttribute("data-change")).toBe("changed");
    expect(draftView.querySelector('[data-step="send"]')?.getAttribute("data-change")).toBeNull();
  });

  it("saves the owner's draft as the next proposed version", async () => {
    const fetchMock = server([draft()]);
    vi.stubGlobal("fetch", fetchMock);
    mount();
    const save = await screen.findByRole("button", { name: "Save as v6" });
    fireEvent.click(save);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/weekly/playbook/drafts/me/save",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = fetchMock.mock.calls.find(([u]) => u === "/api/projects/weekly/playbook/drafts/me/save");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ expected_version: 3 });
  });

  it("shows another member's draft read-only", async () => {
    vi.stubGlobal(
      "fetch",
      server([draft({ user_id: "ada", mine: false, can_edit: false, can_discard: false })]),
    );
    mount(vi.fn(), { canPropose: false, callerUserId: "viewer" });
    fireEvent.click(await screen.findByRole("button", { name: /Draft · ada/ }));
    const draftView = document.querySelector('[data-component="PlaybookDraft"]') as HTMLElement;
    expect(draftView).not.toBeNull();
    expect(within(draftView).queryByRole("button", { name: /Save as/ })).toBeNull();
    expect(within(draftView).queryByRole("button", { name: "Discard draft" })).toBeNull();
    expect(within(draftView).getByText(/read-only/)).toBeTruthy();
  });

  it("quotes a step into the chat with Ask about this", async () => {
    vi.stubGlobal("fetch", server([draft()]));
    const onAsk = mount();
    const button = await screen.findByRole("button", {
      name: "Ask about this: Draft · leo (from v5) · Step 1",
    });
    fireEvent.click(button);
    expect(onAsk).toHaveBeenCalledWith("> **Draft · leo (from v5) · Step 1**\n> Wait for the CRM export\n\n");
  });

  it("offers Ask about this on an active version's paragraphs too", async () => {
    vi.stubGlobal("fetch", server([]));
    const onAsk = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Ask about this: v5 · ¶2" }));
    expect(onAsk).toHaveBeenCalledWith("> **v5 · ¶2**\n> Dedupe rows.\n\n");
  });
});
