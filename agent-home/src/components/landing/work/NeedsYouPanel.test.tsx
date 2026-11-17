// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import type { NeedsYouEntry } from "@/types/landing";

import { NeedsYouPanel, NeedsYouPanelView, sortBySeverity, withoutSuggestedAsks } from "./NeedsYouPanel";
import { needsYouEntry, needsYouResponse } from "./fixtures";
import { resetNeedsYouFeedCache, useNeedsYouFeed } from "./useNeedsYouFeed";

afterEach(() => {
  cleanup();
  resetNeedsYouFeedCache();
  vi.restoreAllMocks();
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const view = { count: 0, newIds: new Set<string>(), loaded: true, stale: false };

describe("NeedsYouPanelView", () => {
  it("shows the all-clear picture when nothing is waiting", () => {
    render(<NeedsYouPanelView {...view} items={[]} />);
    const clear = screen.getByTestId("needs-you-all-clear");
    expect(clear.querySelector("img")?.getAttribute("src")).toBe(
      "/brand/illustrations/needs-you-all-clear@2x.png",
    );
    expect(screen.getByText("Nothing needs you right now")).toBeTruthy();
    expect(screen.getByTestId("needs-you-heading-count").textContent).toBe("0");
  });

  it("shows a skeleton before the first read, not the all-clear", () => {
    render(<NeedsYouPanelView {...view} loaded={false} items={[]} />);
    expect(screen.getByTestId("needs-you-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("needs-you-all-clear")).toBeNull();
  });

  it("lists most urgent first and highlights new ids", () => {
    const items = [
      needsYouEntry({ id: "a", severity: "fyi", title: "FYI" }),
      needsYouEntry({ id: "b", severity: "blocking", title: "Blocked" }),
      needsYouEntry({ id: "c", severity: "approval", title: "Approve" }),
    ];
    const { container } = render(
      <NeedsYouPanelView {...view} count={3} items={items} newIds={new Set(["c"])} />,
    );
    const rows = [...container.querySelectorAll("[data-component=NeedsYouItem]")];
    expect(rows.map((r) => r.getAttribute("data-severity"))).toEqual(["blocking", "approval", "fyi"]);
    expect(rows.map((r) => r.hasAttribute("data-new"))).toEqual([false, true, false]);
  });

  it("keeps the server order within a severity", () => {
    const items = ["x", "y", "z"].map((id) => needsYouEntry({ id }));
    expect(sortBySeverity(items).map((i) => i.id)).toEqual(["x", "y", "z"]);
  });
});

describe("useNeedsYouFeed", () => {
  it("flags entries that appear after the first read and keeps last good data on failure", async () => {
    const first = needsYouResponse([needsYouEntry({ id: "a" })]);
    const second = needsYouResponse([needsYouEntry({ id: "a" }), needsYouEntry({ id: "b" })]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(second))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    const { result } = renderHook(() => useNeedsYouFeed());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.newIds.size).toBe(0);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/needs-you");

    await act(() => result.current.refresh());
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect([...result.current.newIds]).toEqual(["b"]);

    await act(() => result.current.refresh());
    expect(result.current.stale).toBe(true);
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect([...result.current.newIds]).toEqual(["b"]);
  });

  it("treats a missing route as not loaded rather than all clear", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    render(<NeedsYouPanel />);
    await waitFor(() => expect(screen.getByText(/Couldn’t check right now/)).toBeTruthy());
    expect(screen.queryByTestId("needs-you-all-clear")).toBeNull();
  });
});

describe("NeedsYouPanelView with suggested tasks", () => {
  const ask = (id: string, source: NeedsYouEntry["source"], severity: NeedsYouEntry["severity"]) =>
    ({ id, source, severity, title: id, context: {}, created_at: 0, href: "/", actions: [] }) as NeedsYouEntry;

  it("drops a to-do's ask once its suggested task shows, keeping reply approvals", () => {
    const items = [ask("todo-alert", "todo", "fyi"), ask("todo-reply", "todo", "approval"), ask("card", "card_wait", "approval")];
    const suggested = { items: [], loaded: true, error: null, refresh: async () => {}, remove: () => {} };
    expect(withoutSuggestedAsks(items, suggested).map((e) => e.id)).toEqual(["todo-reply", "card"]);
    expect(withoutSuggestedAsks(items, { ...suggested, error: "down" })).toHaveLength(3);
    expect(withoutSuggestedAsks(items, undefined)).toHaveLength(3);
  });
});
