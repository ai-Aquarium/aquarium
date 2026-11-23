// @vitest-environment jsdom
/**
 * Planning → Playbook versioning: pick any version from the chips, compare
 * any two (text diff + step diff), make one active, and leave a version
 * note when saving — all over the existing playbook routes.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/pipeline",
  useRouter: () => router,
}));

import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import type { PlaybookRev, ProjectPlaybookResponse } from "@/types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const BASE = "/api/projects/pipeline";

const rev = (n: number, over: Partial<PlaybookRev> = {}): PlaybookRev => ({
  project_id: "prj_1",
  rev: n,
  body: "Pull the CRM export.\nClean the rows.",
  steps: [
    { key: "pull", title: "Pull the CRM export" },
    { key: "clean", title: "Clean the rows", depends_on: ["pull"] },
  ],
  active: 0,
  created_by: "leo",
  created_at: 1_700_000_000 + n,
  activated_at: null,
  note: null,
  ...over,
});

const V4 = rev(4, { active: 1, activated_at: 1_700_000_100, note: "Reconcile FY26 targets" });
const V5 = rev(5, {
  created_by: "finance",
  note: "Dedupe by opportunity_id + outlier check",
  body: "Pull the CRM export.\nClean the rows and dedupe by opportunity_id.\nFlag outliers.",
  steps: [
    { key: "pull", title: "Pull the CRM export" },
    { key: "clean", title: "Clean the rows + dedupe", depends_on: ["pull"] },
    { key: "flag", title: "Flag outliers", depends_on: ["clean"], checkpoint: true },
  ],
});
const PLAYBOOK: ProjectPlaybookResponse = {
  active: V4,
  revisions: [V5, V4, rev(3, { body: "Pull the CRM export." }), rev(2), rev(1)],
};

const PROPS = {
  slug: "pipeline",
  playbook: PLAYBOOK,
  profiles: ["default", "finance"],
  canActivate: true,
  archived: false,
};

function server(extra?: (url: string, init?: RequestInit) => Response | null) {
  return vi.fn((url: string, init?: RequestInit) => {
    const hit = extra?.(url, init);
    if (hit) return Promise.resolve(hit);
    return Promise.resolve(jsonResponse(200, { status: "idle" }));
  });
}

const chip = (c: HTMLElement, n: number) =>
  c.querySelector(`[data-component="RevisionPicker"] [data-rev="${n}"]`) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

describe("PlanPanel — version picker", () => {
  it("lists every version oldest first, marks active and proposed, and opens on the proposal", () => {
    vi.stubGlobal("fetch", server());
    const { container } = render(<PlanPanel {...PROPS} />);
    const chips = Array.from(container.querySelectorAll('[data-component="RevisionPicker"] [data-rev]'));
    expect(chips.map((c) => c.getAttribute("data-rev"))).toEqual(["1", "2", "3", "4", "5"]);
    expect(chip(container, 4).getAttribute("data-state")).toBe("active");
    expect(chip(container, 4).getAttribute("aria-label")).toBe("v4, active");
    expect(chip(container, 5).textContent).toContain("proposed");
    expect(chip(container, 5).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-component="RevisionMeta"]')?.textContent).toContain(
      "v5: “Dedupe by opportunity_id + outlier check” · by finance",
    );
  });

  it("picking a chip shows that version's text, steps and note", () => {
    vi.stubGlobal("fetch", server());
    const { container } = render(<PlanPanel {...PROPS} />);
    fireEvent.click(chip(container, 4));
    const body = container.querySelector('[data-component="PlaybookRevision"]')!;
    expect(body.getAttribute("data-rev")).toBe("4");
    expect(body.textContent).toContain("Clean the rows");
    expect(body.textContent).not.toContain("Flag outliers");
    expect(container.querySelector('[data-component="RevisionMeta"]')?.textContent).toContain(
      "v4: “Reconcile FY26 targets”",
    );
    // The active version needs no decision.
    expect(container.querySelector('[data-component="RevisionDecision"]')).toBeNull();
  });
});

describe("PlanPanel — compare any two versions", () => {
  it("opens on the picked version against the active one, with a text and a step diff", () => {
    vi.stubGlobal("fetch", server());
    const { container, getByRole } = render(<PlanPanel {...PROPS} />);
    fireEvent.click(getByRole("button", { name: "Compare" }));
    const cmp = container.querySelector('[data-component="RevisionCompare"]') as HTMLElement;
    expect((within(cmp).getByLabelText("Compare from") as HTMLSelectElement).value).toBe("4");
    expect((within(cmp).getByLabelText("Compare to") as HTMLSelectElement).value).toBe("5");

    const removed = Array.from(cmp.querySelectorAll('[data-diff="removed"]')).map((n) => n.textContent);
    const added = Array.from(cmp.querySelectorAll('[data-diff="added"]')).map((n) => n.textContent);
    expect(removed).toEqual(["removed: Clean the rows."]);
    expect(added).toEqual(["added: Clean the rows and dedupe by opportunity_id.", "added: Flag outliers."]);

    const kinds = Array.from(cmp.querySelectorAll("[data-step-diff]")).map((n) => n.getAttribute("data-step-diff"));
    expect(kinds).toEqual(["same", "changed", "added"]);
    expect(cmp.querySelector('[data-step-diff="changed"]')?.textContent).toContain("was “Clean the rows”");
    expect(cmp.querySelector('[data-component="RevisionCompareCounts"]')?.textContent).toBe(
      "1 added · 1 changed · 0 removed",
    );
  });

  it("compares any pair: changing either side, swapping, and identical versions", () => {
    vi.stubGlobal("fetch", server());
    const { container, getByRole } = render(<PlanPanel {...PROPS} />);
    fireEvent.click(getByRole("button", { name: "Compare" }));
    const cmp = () => container.querySelector('[data-component="RevisionCompare"]') as HTMLElement;
    fireEvent.change(within(cmp()).getByLabelText("Compare from"), { target: { value: "3" } });
    fireEvent.change(within(cmp()).getByLabelText("Compare to"), { target: { value: "1" } });
    expect(cmp().textContent).toContain("v3 text");
    expect(cmp().textContent).toContain("v1 text");
    // The "to" side drives the picker too.
    expect(chip(container, 1).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(cmp()).getByRole("button", { name: "Swap the two versions" }));
    expect((within(cmp()).getByLabelText("Compare from") as HTMLSelectElement).value).toBe("1");
    expect((within(cmp()).getByLabelText("Compare to") as HTMLSelectElement).value).toBe("3");

    fireEvent.change(within(cmp()).getByLabelText("Compare from"), { target: { value: "2" } });
    fireEvent.change(within(cmp()).getByLabelText("Compare to"), { target: { value: "1" } });
    expect(cmp().textContent).toContain("v2 and v1 are the same.");
    expect(cmp().querySelector('[data-component="RevisionTextSame"]')).toBeTruthy();

    fireEvent.click(within(cmp()).getByRole("button", { name: "Close compare" }));
    expect(container.querySelector('[data-component="RevisionCompare"]')).toBeNull();
  });

  it("is unavailable with a single version", () => {
    vi.stubGlobal("fetch", server());
    const { getByRole } = render(<PlanPanel {...PROPS} playbook={{ active: V4, revisions: [V4] }} />);
    expect((getByRole("button", { name: "Compare" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PlanPanel — make active and version notes", () => {
  it("Make active on an earlier version sends a note when it had none", async () => {
    const fetchMock = server((url, init) =>
      init?.method === "POST" && url === `${BASE}/playbook/2/activate`
        ? jsonResponse(200, { rev: 2, active: true, by: "leo" })
        : null,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container, getByText } = render(<PlanPanel {...PROPS} />);
    fireEvent.click(chip(container, 2));
    const decision = container.querySelector('[data-component="RevisionDecision"]') as HTMLElement;
    expect(decision.getAttribute("data-state")).toBe("earlier");
    fireEvent.change(decision.querySelector('[data-component="ActivationNote"]')!, {
      target: { value: "  Back to the simple cleaner  " },
    });
    fireEvent.click(getByText("Make active"));
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls.find(([url]) => url === `${BASE}/playbook/2/activate`)!;
    expect(JSON.parse(String(init!.body))).toEqual({ note: "Back to the simple cleaner" });
  });

  it("a version that already has a note activates without asking for one", () => {
    vi.stubGlobal("fetch", server());
    const { container } = render(<PlanPanel {...PROPS} />);
    expect(container.querySelector('[data-component="RevisionDecision"]')?.getAttribute("data-state")).toBe(
      "proposed",
    );
    expect(container.querySelector('[data-component="ActivationNote"]')).toBeNull();
  });

  it("members see who decides instead of Make active", () => {
    vi.stubGlobal("fetch", server());
    const { container, queryByText, getByText } = render(<PlanPanel {...PROPS} canActivate={false} />);
    expect(queryByText("Make active")).toBeNull();
    expect(container.querySelector('[data-action="discard-revision"]')).toBeNull();
    expect(getByText("A lead makes it active or discards it.")).toBeTruthy();
  });

  it("Save sends the version note and opens the new version", async () => {
    const fetchMock = server((url, init) =>
      init?.method === "POST" && url === `${BASE}/playbook` ? jsonResponse(200, { rev: 6, active: false }) : null,
    );
    vi.stubGlobal("fetch", fetchMock);
    const only: ProjectPlaybookResponse = { active: V4, revisions: [V4] };
    const { container, getByText, rerender } = render(<PlanPanel {...PROPS} playbook={only} />);
    fireEvent.click(getByText("Edit"));
    fireEvent.change(container.querySelector('[data-component="VersionNote"]')!, {
      target: { value: "Add the outlier check" },
    });
    fireEvent.click(getByText("Save as revision"));
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls.find(([url, i]) => url === `${BASE}/playbook` && i?.method === "POST")!;
    const sent = JSON.parse(String(init!.body)) as { note?: string; base_rev?: number };
    expect(sent.note).toBe("Add the outlier check");
    expect(sent.base_rev).toBe(4);

    const v6 = rev(6, { note: "Add the outlier check" });
    rerender(<PlanPanel {...PROPS} playbook={{ active: V4, revisions: [v6, V4] }} />);
    expect(chip(container, 6).getAttribute("aria-pressed")).toBe("true");
  });

  it("an empty note is not sent", async () => {
    const fetchMock = server((url, init) =>
      init?.method === "POST" && url === `${BASE}/playbook` ? jsonResponse(200, { rev: 6, active: false }) : null,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getByText } = render(<PlanPanel {...PROPS} playbook={{ active: V4, revisions: [V4] }} />);
    fireEvent.click(getByText("Edit"));
    fireEvent.click(getByText("Save as revision"));
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls.find(([url, i]) => url === `${BASE}/playbook` && i?.method === "POST")!;
    expect(JSON.parse(String(init!.body))).not.toHaveProperty("note");
  });
});
