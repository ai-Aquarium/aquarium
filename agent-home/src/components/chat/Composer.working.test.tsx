// @vitest-environment jsdom
/**
 * The composer while the agent works: the box and Send stay usable, Send is a
 * split button (Steer by default; Queue; Stop & send), Stop stays its own red
 * button, and messages the agent has not read yet show as chips above it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/Composer";
import type { PendingChatInput } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function working(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn<(t: string, a: unknown[], m?: string) => Promise<boolean>>(
    async () => true,
  );
  const onStop = vi.fn();
  const utils = render(
    <Composer
      sending
      storageEnabled={false}
      sessionId="s1"
      onSend={onSend}
      onStop={onStop}
      {...props}
    />,
  );
  return { ...utils, onSend, onStop };
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const chooseMode = (name: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: name }));
};

describe("Composer while the agent works", () => {
  it("keeps the box and a Steer send enabled, with Stop beside it", async () => {
    const { onSend, onStop } = working();
    expect(box().disabled).toBe(false);
    const send = screen.getByRole("button", { name: /^steer$/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true); // nothing typed yet
    type("also check the logs");
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("also check the logs", [], "steer"));
    expect(box().value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /stop the agent/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("lists Steer / Queue / Stop & send and sends with the chosen mode", async () => {
    const { onSend } = working();
    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    const menu = screen.getByRole("menu", { name: /send mode/i });
    expect(within(menu).getAllByRole("menuitemradio").map((b) => b.textContent)).toEqual([
      expect.stringContaining("Steer"),
      expect.stringContaining("Queue"),
      expect.stringContaining("Stop & send"),
    ]);
    expect(within(menu).getByRole("menuitemradio", { name: /^.?steer/i }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /queue/i }));
    expect(screen.queryByRole("menu")).toBeNull();

    type("then write the summary");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("then write the summary", [], "queue"));
    // The mode sticks for the next message.
    expect(screen.getByRole("button", { name: /^queue$/i })).toBeTruthy();
  });

  it("Stop & send is one-off: the next message steers again", async () => {
    const { onSend } = working();
    chooseMode(/stop & send/i);
    expect(screen.getByRole("button", { name: /^stop & send$/i })).toBeTruthy();
    type("forget that, do X");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("forget that, do X", [], "interrupt"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^steer$/i })).toBeTruthy());
  });

  it("closes the mode menu on Escape", () => {
    working();
    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("gives the draft back when a mid-turn send fails", async () => {
    working({ onSend: async () => false });
    type("lost");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box().value).toBe("lost"));
  });

  it("shows plain Send (no mode) when idle", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer sending={false} storageEnabled={false} sessionId="s1" onSend={onSend} />);
    expect(screen.queryByRole("button", { name: /choose how to send/i })).toBeNull();
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", []));
  });

  it("can steer while the first turn's onSend is still pending", async () => {
    let finish: (v: boolean) => void = () => {};
    const onSend = vi.fn((_t: string, _a: unknown[], mode?: string) =>
      mode ? Promise.resolve(true) : new Promise<boolean>((r) => (finish = r)),
    );
    const { rerender } = render(
      <Composer sending={false} storageEnabled={false} sessionId="s1" onSend={onSend} />,
    );
    type("start");
    fireEvent.keyDown(box(), { key: "Enter" });
    await act(async () => {});
    rerender(<Composer sending storageEnabled={false} sessionId="s1" onSend={onSend} />);
    type("steer it");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("steer it", [], "steer"));
    finish(true);
  });
});

describe("Composer pending chips", () => {
  const pending: PendingChatInput[] = [
    { itemId: "s1", mode: "steer", text: "look at B", status: "pending" },
    { itemId: "s2", mode: "steer", text: "and D", status: "deferred" },
    { itemId: "q1", mode: "queue", text: "then C", status: "queued" },
  ];

  it("says when each message will be read, and lets a queued one be removed", () => {
    const onRemovePending = vi.fn();
    working({ pending, onRemovePending });
    const chips = within(screen.getByRole("list", { name: /sent while working/i })).getAllByRole(
      "listitem",
    );
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toContain("look at B");
    expect(chips[0].textContent).toContain("will be read after the current step");
    expect(chips[1].textContent).toContain("will run next");
    expect(chips[2].textContent).toContain("Queued next");
    // Only queued messages can be taken back.
    expect(within(chips[0]).queryByRole("button")).toBeNull();
    fireEvent.click(within(chips[2]).getByRole("button", { name: /remove queued message: then c/i }));
    expect(onRemovePending).toHaveBeenCalledWith("q1");
  });

  it("hides chips once the agent is idle", () => {
    render(
      <Composer sending={false} storageEnabled={false} sessionId="s1" onSend={() => true} pending={pending} />,
    );
    expect(screen.queryByRole("list", { name: /sent while working/i })).toBeNull();
  });
});

describe("Composer at 390px", () => {
  it("stacks chips and opens the mode menu as a bottom sheet over a backdrop", () => {
    window.innerWidth = 390;
    window.dispatchEvent(new Event("resize"));
    working({ pending: [{ itemId: "q1", mode: "queue", text: "then C", status: "queued" }] });
    const chips = screen.getByRole("list", { name: /sent while working/i });
    // One chip per row; a long one truncates inside its own row.
    expect(chips.className).toContain("flex-col");
    expect(within(chips).getByText(/then C/).className).toContain("truncate");

    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    const sheet = screen.getByRole("menu");
    // Below the `sm` breakpoint the menu pins to the bottom edge, full width.
    for (const cls of ["max-sm:fixed", "max-sm:inset-x-0", "max-sm:bottom-0", "max-sm:rounded-t-2xl"]) {
      expect(sheet.className).toContain(cls);
    }
    const backdrop = document.querySelector('[data-component="SendModeBackdrop"]') as HTMLElement;
    expect(backdrop.className).toContain("sm:hidden");
    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Composer layout while working", () => {
  const box = () => document.querySelector('[data-component="Composer"]') as HTMLElement;

  const card = () => document.querySelector('[data-component="ComposerCard"]') as HTMLElement;
  const actions = () => document.querySelector('[data-component="ComposerActions"]') as HTMLElement;

  it("puts the input on its own full-width row, at least three lines tall, with every action below it", () => {
    working({ storageEnabled: true });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.parentElement).toBe(card());
    expect(card().firstElementChild).toBe(input);
    expect(input.rows).toBe(3);
    expect(input.className).toContain("w-full");
    expect(input.className).toContain("min-h-[72px]");
    expect(input.className).toContain("max-h-[min(172px,calc(var(--vv-height,100dvh)*0.4))]");
    // Attach, lock, the status hint, then Stop and the split Steer — in that order.
    const row = Array.from(actions().children).map(
      (el) => el.getAttribute("aria-label") ?? (el as HTMLElement).dataset.component ?? el.tagName,
    );
    expect(row).toEqual(["INPUT", "Attach file", "Share a secret securely", "ComposerHint", "Stop the agent", "SendSplit"]);
    expect(actions().contains(input)).toBe(false);
    const stop = screen.getByRole("button", { name: /stop the agent/i });
    expect(stop.classList.contains("ml-auto")).toBe(true);
    // On a phone Stop shows its icon only; Steer keeps its label.
    expect(within(stop).getByText("Stop").className).toContain("max-sm:sr-only");
    expect(screen.getByRole("button", { name: /^steer$/i }).textContent).toBe("Steer");
  });

  it("explains what Enter does in the hint, hidden on a phone", () => {
    working();
    const hint = document.querySelector('[data-component="ComposerHint"]') as HTMLElement;
    expect(hint.textContent).toBe("Agent is working · Enter steers");
    expect(hint.className).toContain("max-sm:hidden");
    chooseMode(/queue/i);
    expect(hint.textContent).toBe("Agent is working · Enter queues");
  });

  it("keeps the same two-row layout when idle, with Send at the right", () => {
    render(<Composer sending={false} storageEnabled={false} sessionId="s1" onSend={() => true} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.parentElement).toBe(card());
    expect(input.rows).toBe(3);
    expect(document.querySelector('[data-component="ComposerHint"]')!.textContent).toBe(
      "Enter to send · Shift+Enter for a new line",
    );
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(actions().lastElementChild).toBe(send);
    expect(send.classList.contains("ml-auto")).toBe(true);
  });

  it("raises the open mode menu and its backdrop above the floating launchers (z-60)", () => {
    working();
    expect(box().className).not.toContain("z-[70]");
    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    expect(box().className).toContain("z-[70]");
    expect(box().contains(screen.getByRole("menu"))).toBe(true);
    expect(box().contains(document.querySelector('[data-component="SendModeBackdrop"]'))).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /queue/i }));
    expect(box().className).not.toContain("z-[70]");
  });

  it("tells the host when the mode menu opens and closes", () => {
    const onMenuOpenChange = vi.fn();
    working({ onMenuOpenChange });
    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /queue/i }));
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("in a narrow panel keeps the two-row card, icon-only Stop and no status hint", () => {
    working({ narrow: true });
    const input = screen.getByRole("textbox");
    const card = input.parentElement as HTMLElement;
    expect(card.dataset.panelCard).toBe("true");
    expect(card.contains(document.querySelector('[data-component="ComposerActions"]'))).toBe(true);
    const stop = screen.getByRole("button", { name: /stop the agent/i });
    expect(stop.classList.contains("ml-auto")).toBe(true);
    expect(within(stop).getByText("Stop").classList.contains("sr-only")).toBe(true);
    expect(document.querySelector('[data-component="ComposerHint"]')!.classList.contains("hidden")).toBe(true);
  });

  it("in a narrow panel moves the launcher reserve onto the action row, with Send at the right", () => {
    render(<Composer narrow sending={false} storageEnabled sessionId="s1" onSend={() => true} />);
    const root = document.querySelector('[data-component="Composer"]') as HTMLElement;
    expect(root.className).not.toMatch(/(^|\s)ml-14/);
    expect(screen.getByRole("button", { name: /attach file/i }).classList.contains("ml-14")).toBe(true);
    expect(screen.getByRole("button", { name: /^send$/i }).classList.contains("ml-auto")).toBe(true);
  });

  it("moves the left-launcher reserve onto the action row on a phone, idle and working", () => {
    for (const sending of [false, true]) {
      render(<Composer sending={sending} storageEnabled sessionId="s1" onSend={() => true} />);
      const root = document.querySelector('[data-component="Composer"]') as HTMLElement;
      expect(root.classList.contains("ml-14")).toBe(true);
      expect(root.classList.contains("max-sm:ml-0")).toBe(true);
      expect(screen.getByRole("button", { name: /attach file/i }).classList.contains("max-sm:ml-14")).toBe(true);
      cleanup();
    }
  });

  it("adds no reserve where the layout already clears the launcher", () => {
    working({ storageEnabled: true, launcherClearance: false });
    const root = document.querySelector('[data-component="Composer"]') as HTMLElement;
    expect(root.className).not.toContain("ml-14");
    expect(screen.getByRole("button", { name: /attach file/i }).className).not.toContain("ml-14");
  });
});

describe("Composer with a file waiting while the agent works", () => {
  const report = { path: "/uploads/report.pdf", name: "report.pdf", content_type: "application/pdf", size: 10 };
  const seedFile = () =>
    sessionStorage.setItem("agent-home:pending-attachments", JSON.stringify([report]));

  it("still steers text, and keeps the file for the next normal prompt", async () => {
    seedFile();
    const { onSend } = working();
    await screen.findByText("report.pdf");
    type("only the text goes now");
    const send = screen.getByRole("button", { name: /^steer$/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("only the text goes now", [], "steer"),
    );
    expect(box().value).toBe("");
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText(/attachments go with your next prompt/i)).toBeTruthy();
  });

  it("puts the files back when the host could only deliver the text", async () => {
    seedFile();
    const onSend = vi.fn(async () => "attachments_kept" as const);
    render(<Composer sending={false} storageEnabled={false} sessionId="s1" onSend={onSend} />);
    await screen.findByText("report.pdf");
    type("look at this");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("look at this", [report]));
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeTruthy());
    expect(box().value).toBe("");
  });
});

describe("Composer delivered steer", () => {
  it("shows a delivered steer as Delivered, without a remove control", () => {
    working({
      pending: [{ itemId: "i1", mode: "steer", text: "use staging", status: "delivered" }],
      onRemovePending: () => {},
    });
    const chip = within(screen.getByRole("list", { name: /sent while working/i })).getByRole(
      "listitem",
    );
    expect(chip.textContent).toContain("Delivered");
    expect(chip.textContent).not.toContain("will be read");
    expect(within(chip).queryByRole("button")).toBeNull();
  });
});
