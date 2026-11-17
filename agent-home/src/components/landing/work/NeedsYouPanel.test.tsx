// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import type { UseSuggestedTasks } from "@/components/suggested-tasks/useSuggestedTasks";
import type { SuggestedTask } from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

import { NeedsYouPanel, NeedsYouPanelView, needsYouCount, sortBySeverity, withoutSuggestedAsks } from "./NeedsYouPanel";
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
  const KEY = "arrival:email:sales%40acme.hk:msg-1";
  const ask = (id: string, severity: NeedsYouEntry["severity"], context: NeedsYouEntry["context"] = {}) =>
    ({ id, source: "todo", severity, title: id, context, created_at: 0, href: "/", actions: [] }) as NeedsYouEntry;
  const card = {
    channel: "email",
    todo: { id: "t1" },
    source: { id: "m1", surface: "email", account_id: "sales@acme.hk", external_id: "msg-1" },
  } as unknown as SuggestedTask;
  const feed = (items: SuggestedTask[], extra: Partial<UseSuggestedTasks> = {}): UseSuggestedTasks => ({
    items, loaded: true, error: null, profile: "default", refresh: async () => {}, remove: () => {}, ...extra,
  });

  it("drops only the alert a card on screen stands for", () => {
    const items = [
      ask("same-message", "fyi", { arrival_key: KEY }),
      ask("same-message-reply", "approval", { arrival_key: KEY }),
      ask("other-message", "fyi", { arrival_key: "arrival:email:sales%40acme.hk:msg-2" }),
      ask("no-arrival", "fyi"),
    ];
    expect(withoutSuggestedAsks(items, feed([card])).map((e) => e.id)).toEqual([
      "same-message-reply",
      "other-message",
      "no-arrival",
    ]);
  });

  it("keeps alerts raised in another profile, and everything when no card shows", () => {
    const cfo = ask("cfo", "fyi", { arrival_key: KEY, profiles: ["cfo"] });
    const both = ask("both", "fyi", { arrival_key: KEY, profiles: ["cfo", "default"] });
    const here = ask("here", "fyi", { arrival_key: KEY, profiles: ["default"] });
    expect(withoutSuggestedAsks([cfo, both, here], feed([card])).map((e) => e.id)).toEqual(["cfo", "both"]);
    expect(withoutSuggestedAsks([cfo, here], feed([]))).toHaveLength(2);
    expect(withoutSuggestedAsks([here], feed([card], { error: "down" }))).toHaveLength(1);
    expect(withoutSuggestedAsks([here], undefined)).toHaveLength(1);
  });

  it("counts every suggested task, quiet ones included, without the alerts they replace", () => {
    const quiet = { ...card, todo: { id: "t2", stage: "staged" }, source: null } as unknown as SuggestedTask;
    const items = [ask("same-message", "fyi", { arrival_key: KEY }), ask("card-wait", "approval")];
    expect(needsYouCount(2, items, feed([card, quiet]))).toBe(3);
    expect(needsYouCount(2, items, undefined)).toBe(2);
  });
});
