// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import type { UseSuggestedTasks } from "@/components/suggested-tasks/useSuggestedTasks";
import type { SuggestedTask, Todo } from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

import { NeedsYouPanelView } from "./NeedsYouPanel";
import { needsYouEntry } from "./fixtures";

const ANSWER = "/api/comms/notifications/n1/answer";
const view = { count: 0, newIds: new Set<string>(), loaded: true, stale: false };

function reply(over: Partial<NeedsYouEntry> = {}): NeedsYouEntry {
  return needsYouEntry({
    id: "notif:n1",
    source: "todo",
    severity: "approval",
    title: "Send reply to Mrs Chan?",
    detail: "Dear Mrs Chan,\nThank you for the MOU draft.",
    href: "/todos",
    notification_id: "n1",
    context: {
      todo_id: "td1",
      reply_channel: "email",
      reply_to: "mrs.chan@slc.example",
      reply_account: "leo@lauconsulting.hk",
      reply_subject: "Re: MOU review",
    },
    actions: [
      { id: "send", label: "Send", style: "primary", method: "POST", endpoint: ANSWER, body: { answer: "approved" } },
      { id: "revise", label: "Ask for changes", style: "secondary", method: "POST", endpoint: ANSWER },
      { id: "reject", label: "Reject", style: "danger", method: "POST", endpoint: ANSWER, body: { answer: "denied" } },
      { id: "open", label: "Open", style: "secondary", href: "/todos" },
    ],
    ...over,
  });
}

const checkpoint = needsYouEntry({ id: "ny-cp", severity: "blocking", title: "Run 4 is waiting at a checkpoint" });
const fyi = needsYouEntry({ id: "ny-fyi", severity: "fyi", title: "Daily triage review is overdue" });

function suggested(): UseSuggestedTasks {
  const task: SuggestedTask = {
    channel: "whatsapp",
    todo: { id: "d2", ref: "D2", title: "Reply to Ada about FP testing", description: "Ada asks which option.", stage: "open", priority: "high" } as Todo,
    source: { surface: "whatsapp", account_id: null, external_id: null, sender_name: "Ada", sender_id: null, subject: null, body: "Which option should we pick for FP testing?", occurred_at: null },
  };
  return { items: [task], loaded: true, error: null, refresh: vi.fn(async () => {}), remove: vi.fn() } as unknown as UseSuggestedTasks;
}

function mockFetch(answer: unknown = { action: { type: "send", event: "sent" } }) {
  const fn = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    if (init?.method === "POST") return new Response(JSON.stringify(answer), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const posts = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));

const dialog = () => screen.getByRole("dialog");
const titleShown = () => within(dialog()).getByTestId("details-title").textContent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Needs you Details", () => {
  it("opens from the Details pill and from the title of every item", () => {
    mockFetch();
    render(<NeedsYouPanelView {...view} items={[checkpoint, reply()]} suggested={suggested()} />);
    const pills = screen.getAllByRole("button", { name: "Details" });
    expect(pills).toHaveLength(3);

    fireEvent.click(pills[0]);
    expect(titleShown()).toBe("Reply to Ada about FP testing");
    expect(within(dialog()).getByText("Which option should we pick for FP testing?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Send reply to Mrs Chan?" }));
    expect(titleShown()).toBe("Send reply to Mrs Chan?");
    const draft = within(dialog()).getByTestId("details-draft");
    expect(draft.textContent).toContain("mrs.chan@slc.example");
    expect(draft.textContent).toContain("leo@lauconsulting.hk");
    expect(draft.textContent).toContain("Thank you for the MOU draft.");
  });

  it("steps through items with prev / next, wrapping at the ends", () => {
    mockFetch();
    render(<NeedsYouPanelView {...view} items={[fyi, checkpoint, reply()]} />);
    // Most urgent first: checkpoint (blocking), reply (approval), fyi.
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(titleShown()).toBe("Run 4 is waiting at a checkpoint");
    expect(within(dialog()).getByTestId("details-nav").textContent).toContain("1 of 3");

    fireEvent.click(within(dialog()).getByRole("button", { name: "Next item" }));
    expect(titleShown()).toBe("Send reply to Mrs Chan?");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Next item" }));
    expect(titleShown()).toBe("Daily triage review is overdue");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Next item" }));
    expect(titleShown()).toBe("Run 4 is waiting at a checkpoint");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous item" }));
    expect(titleShown()).toBe("Daily triage review is overdue");
  });

  it("sends a reply only after the confirm step", async () => {
    const fetchFn = mockFetch();
    const onActed = vi.fn();
    render(<NeedsYouPanelView {...view} items={[reply()]} onActed={onActed} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    fireEvent.click(within(dialog()).getByRole("button", { name: "Send…" }));
    expect(posts(fetchFn)).toEqual([]);
    const confirm = within(dialog()).getByTestId("details-confirm");
    expect(confirm.textContent).toContain("Send this email to mrs.chan@slc.example from leo@lauconsulting.hk?");

    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(dialog()).queryByTestId("details-confirm")).toBeNull();
    expect(posts(fetchFn)).toEqual([]);

    fireEvent.click(within(dialog()).getByRole("button", { name: "Send…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes, send" }));
    await waitFor(() => expect(onActed).toHaveBeenCalledTimes(1));
    expect(posts(fetchFn)).toEqual([{ url: ANSWER, body: { answer: "approved" } }]);
  });

  it("sends typed feedback for a rewrite and follows the reply to its new draft", async () => {
    const fetchFn = mockFetch({ action: { type: "revision", session_id: "s1" } });
    const onActed = vi.fn();
    const { rerender } = render(<NeedsYouPanelView {...view} items={[reply()]} onActed={onActed} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Ask for changes" }));

    fireEvent.click(within(dialog()).getByRole("button", { name: "Rewrite draft" }));
    expect(within(dialog()).getByText("Say what should change.")).toBeTruthy();
    expect(posts(fetchFn)).toEqual([]);

    fireEvent.change(within(dialog()).getByLabelText("What should change?"), {
      target: { value: "Warmer tone; ask how many staff will join" },
    });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Rewrite draft" }));
    await waitFor(() => expect(within(dialog()).getByTestId("details-rewriting")).toBeTruthy());
    expect(posts(fetchFn)).toEqual([
      { url: ANSWER, body: { answer: "Warmer tone; ask how many staff will join", feedback: true } },
    ]);
    expect(onActed).toHaveBeenCalledTimes(1);

    // The answered approval leaves; the rewritten draft arrives as a new one.
    rerender(<NeedsYouPanelView {...view} items={[]} onActed={onActed} />);
    expect(within(dialog()).getByTestId("details-rewriting")).toBeTruthy();
    const v2 = reply({ id: "notif:n2", notification_id: "n2", detail: "Dear Mrs Chan,\nHow many staff will join?" });
    rerender(<NeedsYouPanelView {...view} items={[v2]} onActed={onActed} />);
    expect(within(dialog()).getByTestId("details-rewritten").textContent).toContain("Warmer tone; ask how many staff will join");
    expect(within(dialog()).getByTestId("details-draft").textContent).toContain("How many staff will join?");
    expect(within(dialog()).getByRole("button", { name: "Send…" })).toBeTruthy();
  });
});
