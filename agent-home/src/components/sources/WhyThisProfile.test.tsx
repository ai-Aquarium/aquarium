// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decision } from "@/components/sources/fixtures";
import { sourceRoutingHref, WhyThisProfile } from "@/components/sources/WhyThisProfile";
import { Sheet } from "@/components/ui/Sheet";

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
    expect(screen.queryByRole("link", { name: /Recent routing/ })).toBeNull();

    // Close, reopen: the decision is kept, not fetched again.
    await press(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("why-this-profile-popover")).toBeNull();
    await press(link());
    expect(screen.getByTestId("why-this-profile-popover")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("links to recent routing when the caller gives a Sources href", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision()] })));
    render(
      <WhyThisProfile
        sourceId="src-mail"
        batchId="b-1"
        profile="CFO"
        recentRoutingHref={sourceRoutingHref}
      />,
    );
    await press(link());
    expect(screen.getByRole("link", { name: "Recent routing for john@acme.com" }).getAttribute("href")).toBe(
      "/settings/sources/src-mail/routing",
    );
    expect(screen.getByRole("link", { name: "Edit what CFO cares about" }).getAttribute("href")).toBe(
      "/profiles/CFO/triage?kind=email",
    );
  });

  it("flips above a link near the bottom of the window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision()] })));
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    vi.spyOn(link(), "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 40, bottom: window.innerHeight - 24, left: 100, right: 220, width: 120, height: 16, x: 100, y: 0, toJSON() {},
    } as DOMRect);
    await press(link());
    const style = screen.getByTestId("why-this-profile-popover").style;
    expect(style.top).toBe("");
    expect(style.bottom).toBe("48px");
  });

  it("opens My triage skills for the profile on the batch's channel tab", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision({ channel: "whatsapp" })] })));
    render(<WhyThisProfile sourceId="src-wa" batchId="b-2" profile="Sales & Ops" />);
    await press(link());
    expect(screen.getByRole("link", { name: "Edit what Sales & Ops cares about" }).getAttribute("href")).toBe(
      "/profiles/Sales%20%26%20Ops/triage?kind=whatsapp",
    );
  });

  it("inside a sheet, layers in the sheet's panel so its links stay clickable; Esc closes only the popover", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision()] })));
    const onClose = vi.fn();
    render(
      <Sheet title="Needs you" onClose={onClose}>
        <WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" recentRoutingHref={sourceRoutingHref} />
      </Sheet>,
    );
    await press(link());
    const popover = screen.getByTestId("why-this-profile-popover");
    const panel = popover.closest("[data-sheet-panel]");
    expect(panel).not.toBeNull();
    expect(panel?.closest('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    await press(screen.getByRole("link", { name: "Edit what CFO cares about" }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByTestId("why-this-profile-popover")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("on the page itself, still portals to <body>", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision()] })));
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    expect(screen.getByTestId("why-this-profile-popover").parentElement).toBe(document.body);
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

  it("an outside press closes the popover; a press inside keeps it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ decisions: [decision()] })));
    render(<WhyThisProfile sourceId="src-mail" batchId="b-1" profile="CFO" />);
    await press(link());
    await act(async () => {
      fireEvent.pointerDown(screen.getByText("CFO"));
    });
    expect(screen.getByTestId("why-this-profile-popover")).toBeTruthy();
    await act(async () => {
      fireEvent.pointerDown(document.body);
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
