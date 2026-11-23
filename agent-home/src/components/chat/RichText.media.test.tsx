// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RichText } from "@/components/chat/RichText";
import { mediaContentRef, mediaRef } from "@/lib/chat/media-ref";

const KEY = (name: string) => `mia_member/files/ab/0123456789abcdef-${name}`;
const fetchMock = vi.fn();

function q(root: HTMLElement, sel: string): HTMLElement | null {
  return root.querySelector(sel);
}

describe("RichText private-bucket media refs (agent-made files)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The read route answers with the loadable content URL for the path.
    fetchMock.mockImplementation(async (input: string) => {
      const path = new URL(input, "http://home.test").searchParams.get("path")!;
      return { ok: true, json: async () => ({ path, url: mediaContentRef(path) }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", undefined);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("draws a [name](mediaRef) link as a ChatFile chip, never a link to the JSON route", async () => {
    const { container } = render(
      <RichText content={`Here: [Q3 sales.xlsx](${mediaRef(KEY("Q3-sales.xlsx"))})`} />,
    );
    const chip = q(container, '[data-component="ChatFile"]')!;
    expect(chip.textContent).toContain("Q3 sales.xlsx");
    await waitFor(() => expect(q(chip, 'a[data-action="download"]')).toBeTruthy());
    const a = q(chip, 'a[data-action="download"]')!;
    expect(a.getAttribute("href")).toBe(`${mediaContentRef(KEY("Q3-sales.xlsx"))}&download=1`);
    expect(a.getAttribute("download")).toBe("Q3-sales.xlsx");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(container.querySelector('a[href^="/api/chat/media?"]')).toBeNull();
  });

  it("opens a PDF ref in a new tab, with a separate Download", async () => {
    const { container } = render(
      <RichText content={`[Report](${mediaRef(KEY("report.pdf"))})`} />,
    );
    await waitFor(() => expect(q(container, 'a[data-action="open"]')).toBeTruthy());
    const open = q(container, 'a[data-action="open"]')!;
    expect(open.getAttribute("href")).toBe(mediaContentRef(KEY("report.pdf")));
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener");
    expect(open.hasAttribute("download")).toBe(false);
    expect(q(container, 'a[data-action="download"]')!.getAttribute("download")).toBe("report.pdf");
  });

  it("names the chip after the file when the link text is empty", () => {
    const { container } = render(<RichText content={`[](${mediaRef(KEY("chart.png"))})`} />);
    expect(q(container, '[data-component="ChatFile"]')!.textContent).toContain("chart.png");
  });

  it("lets an inline image open full size in a new tab and download", async () => {
    const { container } = render(
      <RichText content={`![Sales chart](${mediaRef(KEY("chart.png"))})`} />,
    );
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    const src = mediaContentRef(KEY("chart.png"));
    expect(container.querySelector("img")!.getAttribute("src")).toBe(src);
    const open = q(container, 'a[data-action="open-image"]')!;
    expect(open.getAttribute("href")).toBe(src);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener");
    expect(q(container, 'a[data-action="open-full"]')!.getAttribute("href")).toBe(src);
    const dl = q(container, '[data-component="ChatMedia"] a[data-action="download"]')!;
    expect(dl.getAttribute("href")).toBe(`${src}&download=1`);
    expect(dl.getAttribute("download")).toBe("chart.png");
  });

  it("leaves plain external links as links that strip the Referer", () => {
    const { container } = render(<RichText content="[docs](https://example.com/x)" />);
    const a = q(container, 'a[href="https://example.com/x"]')!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(q(container, '[data-component="ChatFile"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
