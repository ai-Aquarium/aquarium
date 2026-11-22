// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HtmlFileViewer } from "@/components/files/HtmlFileViewer";

describe("HtmlFileViewer", () => {
  afterEach(cleanup);

  it("frames the page sandboxed without same-origin, then drops the loading state", () => {
    const { container } = render(<HtmlFileViewer id="f 1" title="chart.html" />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/files/f%201/content?view=1");
    const sandbox = frame.getAttribute("sandbox")!.split(" ");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(container.querySelector('[data-component="PanelLoading"]')).not.toBeNull();
    fireEvent.load(frame);
    expect(container.querySelector('[data-component="PanelLoading"]')).toBeNull();
  });

  it("offers Download once per click", () => {
    const { container } = render(<HtmlFileViewer id="f1" title="chart.html" />);
    const link = within(container).getByText("Download").closest("a")!;
    expect(link.getAttribute("href")).toBe("/api/files/f1/content?download=1");
    fireEvent.click(link);
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.textContent).toContain("Downloading…");
    const second = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
  });
});
