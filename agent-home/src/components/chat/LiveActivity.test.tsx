// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveActivity } from "@/components/chat/LiveActivity";

describe("LiveActivity", () => {
  afterEach(cleanup);

  it("renders nothing without activity", () => {
    const { container } = render(<LiveActivity reasoning="" tools={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("maximizes in place to full screen with every step and the full reasoning", () => {
    const reasoning = "line one\n".repeat(40) + "last line";
    render(
      <LiveActivity
        reasoning={reasoning}
        tools={[
          { id: "a", name: "terminal", done: true },
          { id: "b", name: "vision_analyze", done: false },
        ]}
      />,
    );
    const live = document.querySelector('[data-component="LiveReasoning"]')!;
    expect(live.className).toContain("max-h-24");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Maximize Agent activity" }));
    const panel = screen.getByRole("dialog", { name: "Agent activity" });
    expect(panel.getAttribute("data-component")).toBe("LiveActivity");
    expect(panel.className).toContain("fixed inset-0");
    expect(panel.textContent).toContain("terminal — done");
    expect(panel.textContent).toContain("vision_analyze — running…");
    const full = panel.querySelector('[data-component="LiveReasoning"]')!;
    expect(full).toBe(live);
    expect(full.textContent).toBe(reasoning);
    expect(full.className).not.toContain("max-h-24");
    expect(full.closest(".overflow-y-auto")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("⤢ Maximize")).toBeTruthy();
  });
});
