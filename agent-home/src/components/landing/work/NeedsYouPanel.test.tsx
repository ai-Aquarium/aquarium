// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import type { UseSuggestedTasks } from "@/components/suggested-tasks/useSuggestedTasks";
import type { SuggestedTask } from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

import {
  NeedsYouPanel,
  NeedsYouPanelView,
  needsYouCount,
  sortBySeverity,
  withoutSuggestedAsks,
} from "./NeedsYouPanel";
import { needsYouEntry, needsYouResponse } from "./fixtures";
import { resetNeedsYouFeedCache, useNeedsYouFeed } from "./useNeedsYouFeed";

afterEach(() => {
  cleanup();
  resetNeedsYouFeedCache();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const view = {
  count: 0,
  newIds: new Set<string>(),
  loaded: true,
  stale: false,
};

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
      <NeedsYouPanelView
        {...view}
        count={3}
        items={items}
        newIds={new Set(["c"])}
      />,
    );
    const rows = [
      ...container.querySelectorAll("[data-component=NeedsYouItem]"),
    ];
    expect(rows.map((r) => r.getAttribute("data-severity"))).toEqual([
      "blocking",
      "approval",
      "fyi",
    ]);
    expect(rows.map((r) => r.hasAttribute("data-new"))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("keeps the server order within a severity", () => {
    const items = ["x", "y", "z"].map((id) => needsYouEntry({ id }));
    expect(sortBySeverity(items).map((i) => i.id)).toEqual(["x", "y", "z"]);
  });
});

describe("useNeedsYouFeed", () => {
  it("flags entries that appear after the first read and keeps last good data on failure", async () => {
    const first = needsYouResponse([needsYouEntry({ id: "a" })]);
    const second = needsYouResponse([
      needsYouEntry({ id: "a" }),
      needsYouEntry({ id: "b" }),
    ]);
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 404 }),
    );
    render(<NeedsYouPanel />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn’t check right now/)).toBeTruthy(),
    );
    expect(screen.queryByTestId("needs-you-all-clear")).toBeNull();
  });
});

describe("NeedsYouPanelView with suggested tasks", () => {
  const KEY = "arrival:email:sales%40acme.hk:msg-1";
  const ask = (
    id: string,
    severity: NeedsYouEntry["severity"],
    context: NeedsYouEntry["context"] = {},
  ) =>
    ({
      id,
      source: "todo",
      severity,
      title: id,
      context,
      created_at: 0,
      href: "/",
      actions: [],
    }) as NeedsYouEntry;
  const card = {
    channel: "email",
    todo: { id: "t1" },
    source: {
      id: "m1",
      surface: "email",
      account_id: "sales@acme.hk",
      external_id: "msg-1",
    },
  } as unknown as SuggestedTask;
  const feed = (
    items: SuggestedTask[],
    extra: Partial<UseSuggestedTasks> = {},
  ): UseSuggestedTasks => ({
    items,
    loaded: true,
    error: null,
    profile: "default",
    refresh: async () => {},
    remove: () => {},
    ...extra,
  });

  it("drops only the alert a card on screen stands for", () => {
    const items = [
      ask("same-message", "fyi", { arrival_key: KEY }),
      ask("same-message-reply", "approval", { arrival_key: KEY }),
      ask("other-message", "fyi", {
        arrival_key: "arrival:email:sales%40acme.hk:msg-2",
      }),
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
    const both = ask("both", "fyi", {
      arrival_key: KEY,
      profiles: ["cfo", "default"],
    });
    const here = ask("here", "fyi", {
      arrival_key: KEY,
      profiles: ["default"],
    });
    expect(
      withoutSuggestedAsks([cfo, both, here], feed([card])).map((e) => e.id),
    ).toEqual(["cfo", "both"]);
    expect(withoutSuggestedAsks([cfo, here], feed([]))).toHaveLength(2);
    expect(
      withoutSuggestedAsks([here], feed([card], { error: "down" })),
    ).toHaveLength(1);
    expect(withoutSuggestedAsks([here], undefined)).toHaveLength(1);
  });

  it("counts every suggested task, quiet ones included, without the alerts they replace", () => {
    const quiet = {
      ...card,
      todo: { id: "t2", stage: "staged" },
      source: null,
    } as unknown as SuggestedTask;
    const items = [
      ask("same-message", "fyi", { arrival_key: KEY }),
      ask("card-wait", "approval"),
    ];
    expect(needsYouCount(2, items, feed([card, quiet]))).toBe(3);
    expect(needsYouCount(2, items, undefined)).toBe(2);
  });

  it("counts past the loaded page without counting an unloaded task and its alert twice", () => {
    // 50 quiet suggestions loaded; one older open suggestion (t-old) is on page 2
    // and has its own alert. 51 tasks need you, however many pages are loaded.
    const page1 = Array.from(
      { length: 50 },
      (_, i) =>
        ({
          ...card,
          todo: { id: `q${i}`, stage: "staged" },
          source: null,
        }) as unknown as SuggestedTask,
    );
    const older = ask("old-alert", "fyi", {
      todo_id: "t-old",
      suggested: true,
      arrival_key: KEY,
      profile: "default",
    });
    const tally = { count: 51 };
    expect(needsYouCount(1, [older], feed(page1), tally)).toBe(51);
    expect(needsYouCount(1, [older], feed([...page1, card]), tally)).toBe(51);
    // Another profile's alert for the same to-do id is not this task.
    const elsewhere = ask("other-profile", "fyi", {
      todo_id: "t-old",
      suggested: true,
      profiles: ["default", "cfo"],
    });
    expect(needsYouCount(1, [elsewhere], feed(page1), tally)).toBe(52);
    // Approvals always count on their own.
    const approval = ask("reply", "approval", { todo_id: "t-old" });
    expect(needsYouCount(1, [approval], feed(page1), tally)).toBe(52);
  });

  it("counts a suggested task and its alert once however many alerts there are", () => {
    const alerts = Array.from({ length: 250 }, (_, i) =>
      ask(`a${i}`, "fyi", {
        todo_id: `s${i}`,
        suggested: true,
        profile: "default",
      }),
    );
    const started = ask("started", "fyi", {
      todo_id: "w1",
      profile: "default",
    });
    const tally = { count: 250 };
    expect(needsYouCount(251, [...alerts, started], feed([]), tally)).toBe(251);
  });
});

describe("NeedsYouPanelView filters", () => {
  const suggestedFeed = (items: SuggestedTask[]): UseSuggestedTasks => ({
    items,
    loaded: true,
    error: null,
    profile: "default",
    refresh: async () => {},
    remove: () => {},
  });
  const sug = (id: string) =>
    ({
      channel: "other",
      todo: { id, title: `suggestion ${id}` },
      source: null,
    }) as unknown as SuggestedTask;
  const items = [
    needsYouEntry({
      id: "proj",
      title: "run waiting",
      context: { project_slug: "wa", project_name: "WhatsAppHistory mirror" },
    }),
    needsYouEntry({ id: "mine-todo", source: "todo", context: {}, title: "mine" }),
    needsYouEntry({ id: "team-1", source: "data_health", context: {}, team: true, title: "team" }),
    needsYouEntry({
      id: "theirs",
      source: "todo",
      context: {},
      foreign: true,
      owner_user_id: "u-ada",
      title: "theirs",
    }),
  ];
  const chips = () =>
    [...document.querySelectorAll("[data-component=Chip]")].map(
      (c) => c.textContent,
    );
  const rows = () =>
    [...document.querySelectorAll("[data-component=NeedsYouItem]")];

  it("opens the filter row from the header and lists only buckets present", () => {
    render(<NeedsYouPanelView {...view} count={4} items={items} />);
    expect(screen.queryByTestId("needs-you-filters")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const filters = screen.getByTestId("needs-you-filters");
    expect(filters).toBeTruthy();
    expect(chips()).toEqual([
      "All",
      "Projects ·1",
      "Messages & to-dos ·2",
      "Data dictionary ·1",
      "All",
      "Me ·2",
      "Team ·1",
      "u-ada ·1",
    ]);
    // "Suggested tasks" chip appears only when a suggested task is loaded.
    expect(chips().some((c) => c?.startsWith("Suggested tasks"))).toBe(false);
  });

  it("narrows to a source bucket and counts against the unfiltered total", () => {
    render(
      <NeedsYouPanelView
        {...view}
        count={4}
        items={items}
        suggested={suggestedFeed([sug("s1")])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Suggested tasks ·1" }),
    );
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId("needs-you-filtered").textContent).toContain(
      "Showing 1 of 5",
    );
    expect(screen.getByText("suggestion s1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Projects ·1" }));
    // Selecting a second bucket shows both.
    expect(rows().map((r) => r.getAttribute("data-severity"))).toHaveLength(1);
    expect(screen.getByTestId("needs-you-filtered").textContent).toContain(
      "Showing 2 of 5",
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(rows()).toHaveLength(4);
    expect(screen.queryByTestId("needs-you-filtered")).toBeNull();
  });

  it("filters by who — team, a person, and me+another together", () => {
    render(<NeedsYouPanelView {...view} count={4} items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Team ·1" }));
    expect(rows().map((r) => r.getAttribute("data-severity"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Team ·1" }));
    fireEvent.click(screen.getByRole("button", { name: "u-ada ·1" }));
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Me ·2" }));
    expect(rows()).toHaveLength(3);
  });

  it("shows the filter-empty state, not the all-clear, when nothing matches", () => {
    render(<NeedsYouPanelView {...view} count={4} items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Team ·1" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects ·1" }));
    expect(screen.getByTestId("needs-you-filter-empty")).toBeTruthy();
    expect(screen.queryByTestId("needs-you-all-clear")).toBeNull();
  });

  it("keeps the filter and open row across a remount", () => {
    const first = render(<NeedsYouPanelView {...view} count={4} items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Team ·1" }));
    expect(rows()).toHaveLength(1);
    expect(window.localStorage.getItem("aquarium.needsYou.filter")).toBe(
      JSON.stringify({ groups: [], who: ["team"] }),
    );
    expect(window.localStorage.getItem("aquarium.needsYou.filterOpen")).toBe("1");
    first.unmount();

    render(<NeedsYouPanelView {...view} count={4} items={items} />);
    // Still filtered — and the row stayed open — without touching anything.
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("needs-you-filters")).toBeTruthy();
    expect(screen.getByTestId("needs-you-filtered").textContent).toContain(
      "Showing 1 of 4",
    );
  });

  it("prunes a persisted who id that no longer has items", () => {
    window.localStorage.setItem(
      "aquarium.needsYou.filter",
      JSON.stringify({ groups: [], who: ["u-gone", "team"] }),
    );
    render(<NeedsYouPanelView {...view} count={4} items={items} />);
    expect(rows()).toHaveLength(1);
    expect(window.localStorage.getItem("aquarium.needsYou.filter")).toBe(
      JSON.stringify({ groups: [], who: ["team"] }),
    );
  });
});

describe("needsYouCount with a wider Viewing", () => {
  it("never counts other people's waits", () => {
    const theirs = {
      ...needsYouEntry(),
      id: "theirs",
      foreign: true,
      owner_user_id: "ada",
    } as NeedsYouEntry;
    expect(needsYouCount(0, [theirs], undefined)).toBe(0);
    expect(needsYouCount(0, [theirs], undefined, { count: 0 } as never)).toBe(
      0,
    );
  });
});
