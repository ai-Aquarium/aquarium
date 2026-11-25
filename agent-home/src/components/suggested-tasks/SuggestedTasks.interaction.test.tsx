// @vitest-environment jsdom
/**
 * Suggested tasks: the Inbox tab filters by channel, Work on this opens the
 * Start task sheet prefilled from the to-do and its message and starts it in
 * Manual, Snooze and Dismiss drop the card, and viewers get no Work on this.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/inbox",
  useRouter: () => router,
}));

import type { SuggestedTask, Todo } from "@/types";

import { SuggestedTasksInbox } from "./SuggestedTasksInbox";
import type { UseSuggestedTasks } from "./useSuggestedTasks";

function task(id: string, channel: string, title: string, withSource = true): SuggestedTask {
  return {
    channel,
    todo: { id, ref: `D${id}`, title, description: "", stage: "open", priority: "normal" } as Todo,
    source: withSource
      ? { id: `m${id}`, surface: channel, account_id: null, sender_name: "Ada", sender_id: null, subject: `Re ${title}`, body: "Can we submit by Friday?", occurred_at: null }
      : null,
  };
}

const ITEMS = [task("88", "email", "Reply to Ada"), task("90", "whatsapp", "Quote Mr Chan"), task("92", "telegram", "Tell Kwok")];

function feed(items = ITEMS): UseSuggestedTasks {
  return { items, loaded: true, error: null, refresh: vi.fn(async () => {}), remove: vi.fn() };
}

function mockFetch(body: unknown = { slug: "reply-to-ada", created: true }) {
  const fn = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockReset();
});

const titles = () => screen.queryAllByRole("article").map((a) => a.querySelector("p.font-semibold")?.textContent);

describe("Suggested tasks", () => {
  it("filters by channel tag", () => {
    render(<SuggestedTasksInbox feed={feed()} />);
    expect(titles()).toEqual(["Reply to Ada", "Quote Mr Chan", "Tell Kwok"]);
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp/ }));
    expect(titles()).toEqual(["Quote Mr Chan"]);
    fireEvent.click(screen.getByRole("button", { name: /^Calendar/ }));
    expect(screen.getByText("No suggested tasks from this channel.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^All channels/ }));
    expect(titles()).toHaveLength(3);
  });

  it("Work on this opens Start task prefilled, and starts it in Manual from the to-do", async () => {
    const fetchFn = mockFetch();
    render(<SuggestedTasksInbox feed={feed()} />);
    fireEvent.click(within(screen.getAllByRole("article")[0]).getByRole("button", { name: "Work on this" }));
    const sheet = await screen.findByRole("dialog");
    const box = within(sheet).getByLabelText("What should the agent do?") as HTMLTextAreaElement;
    expect(box.value).toBe('Reply to Ada\n\nSource: Ada — "Can we submit by Friday?"');
    expect(within(sheet).getByText("Attached: Re Reply to Ada")).toBeTruthy();
    expect(within(sheet).getByText("Every step (Manual)")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/projects/reply-to-ada"));
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/projects/quick-task");
    // Unedited: the server writes the brief from the to-do and its message.
    expect(JSON.parse(String(init?.body))).toEqual({ from_todo: { id: "88" }, autonomy: "manual" });
  });

  it("lets the person pick another check-in level, Manual by default", async () => {
    const fetchFn = mockFetch();
    render(<SuggestedTasksInbox feed={feed()} />);
    fireEvent.click(within(screen.getAllByRole("article")[0]).getByRole("button", { name: "Work on this" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("radio", { name: "Every step (Manual)" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(sheet).getByRole("radio", { name: "Before risky steps" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).autonomy).toBe("supervised");
  });

  it("sends the person's own wording when they reword the ask", async () => {
    const fetchFn = mockFetch();
    render(<SuggestedTasksInbox feed={feed()} />);
    fireEvent.click(within(screen.getAllByRole("article")[1]).getByRole("button", { name: "Work on this" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("What should the agent do?"), {
      target: { value: "Quote 40 units at the usual price" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      from_todo: { id: "90" },
      request: "Quote 40 units at the usual price",
      autonomy: "manual",
    });
  });

  it("Snooze offers 1 min / 1 day / 1 week, Dismiss drops the card", async () => {
    const fetchFn = mockFetch({});
    const f = feed();
    render(<SuggestedTasksInbox feed={f} />);
    const card = screen.getAllByRole("article")[0];
    fireEvent.click(within(card).getByRole("button", { name: "Snooze" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["1 min", "1 day", "1 week"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "1 day" }));
    await waitFor(() => expect(f.remove).toHaveBeenCalledWith("88"));
    expect(fetchFn.mock.calls[0][0]).toBe("/api/suggested-tasks/88/snooze");
    const until = Date.parse(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).until);
    expect(until - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(screen.getByText("Snoozed D88 for 1 day.")).toBeTruthy();
    fireEvent.click(within(screen.getAllByRole("article")[2]).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(f.remove).toHaveBeenCalledWith("92"));
    expect(fetchFn.mock.calls[1][0]).toBe("/api/suggested-tasks/92/dismiss");
  });

  it("a refused Dismiss keeps the card and says why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "No such to-do" }), { status: 404 })),
    );
    const f = feed();
    render(<SuggestedTasksInbox feed={f} />);
    fireEvent.click(within(screen.getAllByRole("article")[0]).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.getByText("No such to-do")).toBeTruthy());
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("offers the next page while there is one", async () => {
    const loadMore = vi.fn(async () => {});
    render(<SuggestedTasksInbox feed={{ ...feed(), nextCursor: "c2", loadMore }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Calendar/ }));
    expect(screen.getByText("None from this channel in the ones loaded so far.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more suggestions" }));
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
  });

  it("viewers see suggestions but cannot start one", () => {
    render(<SuggestedTasksInbox feed={feed()} canStart={false} />);
    expect(screen.queryByRole("button", { name: "Work on this" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Snooze" })).toHaveLength(3);
  });
});
