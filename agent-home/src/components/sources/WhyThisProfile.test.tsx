// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decision } from "@/components/sources/fixtures";
import { WhyThisProfile } from "@/components/sources/WhyThisProfile";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function screenIs(desktop: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: desktop, media: q, addEventListener() {}, removeEventListener() {} }));
}

async function press(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const link = () => screen.getByRole("button", { name: "Why this profile?" });

beforeEach(() => screenIs(true));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WhyThisProfile", () => {
  it.each([
    [null, "b-1"],
    ["src-mail", null],
    [undefined, undefined],
  ])("renders nothing without routing info (%s, %s)", (sourceId, batchId) => {
    const { container } = render(<WhyThisProfile sourceId={sourceId} batchId={batchId} profile="CFO" />);
    expect(container.innerHTML).toBe("");
  });

  it("loads the batch's decision once and shows it in a desktop popover", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ decisions: [decision()] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);

    await press(link());
    const popover = screen.getByTestId("why-this-profile-popover");
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(screen.getByRole("heading", { name: "Why CFO got this" })).toBeTruthy();
    expect(screen.getAllByTestId("route-choice")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/sources/decisions?source_id=src-mail&batch_id=b-1&limit=1");
    expect(screen.getByRole("link", { name: "Recent routing for john@acme.com" }).getAttribute("href")).toBe(
      "/sources?source=src-mail",
    );

    // Close, reopen: the decision is kept, not fetched again.
    await press(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("why-this-profile-popover")).toBeNull();
    await press(link());
    expect(screen.getByTestId("why-this-profile-popover")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the popover", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision()] })));
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByTestId("why-this-profile-popover")).toBeNull();
  });

  it("titles a fallback for every profile (4b)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        reply({ decisions: [decision({ fallback: true, attempts: 3, choices: [{ profile: "CFO", selected: true, reason: "" }] })] }),
      ),
    );
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    expect(screen.getByRole("heading", { name: "Why all your profiles got this" })).toBeTruthy();
    expect(screen.getByText("Got it · fallback")).toBeTruthy();
  });

  it("shows loading while the request is out and never sends a second one", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal("fetch", fetchMock);
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    expect(screen.getByRole("status").textContent).toContain("Loading the routing decision");
    await press(link()); // closes
    await press(link()); // reopens while still loading
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(reply({ decisions: [decision()] }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getAllByTestId("route-choice")).toHaveLength(2);
  });

  it("shows a short error with Try again, which retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ detail: "boom /var/lib/secret" }, 502))
      .mockResolvedValueOnce(reply({ decisions: [decision()] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    expect(screen.getByText("Couldn’t load why this was routed.")).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
    await press(screen.getByRole("button", { name: "Try again" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("route-choice")).toHaveLength(2);
  });

  it("says so when the batch has no decision any more", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [] })));
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    expect(screen.getByText("There’s no routing record for this batch any more.")).toBeTruthy();
  });

  it("opens a bottom sheet on a phone, closable from its X", async () => {
    screenIs(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision()] })));
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    expect(screen.queryByTestId("why-this-profile-popover")).toBeNull();
    const sheet = document.querySelector('[data-component="WhyThisProfileSheet"]');
    expect(sheet).toBeTruthy();
    expect(screen.getAllByTestId("route-choice")).toHaveLength(2);
    const close = screen.getAllByRole("button").find((b) => /close/i.test(b.getAttribute("aria-label") ?? ""));
    await press(close!);
    expect(document.querySelector('[data-component="WhyThisProfileSheet"]')).toBeNull();
  });
});
