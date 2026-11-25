import { describe, expect, it } from "vitest";

import {
  formatUiContext,
  getUiContext,
  setUiContext,
} from "@/lib/app-mcp/state";

describe("app-mcp UI context store", () => {
  it("stores and returns the current context", () => {
    setUiContext({ path: "/todos", element: { role: "button", name: "Filter" } });
    expect(getUiContext()).toEqual({
      path: "/todos",
      element: { role: "button", name: "Filter" },
    });
  });

  it("formats the awareness line with an element", () => {
    const line = formatUiContext({
      path: "/todos",
      element: { role: "button", name: "Filter" },
    });
    expect(line).toBe('[app context: page /todos · last active: button "Filter"]');
  });

  it("names the section the element sits in", () => {
    const line = formatUiContext({
      path: "/",
      element: { role: "button", name: "Snooze", section: "SuggestedTaskCard: Reply to Ada" },
    });
    expect(line).toBe(
      '[app context: page / · last active: button "Snooze" in "SuggestedTaskCard: Reply to Ada"]',
    );
  });

  it("says 'none' when no element has been touched yet", () => {
    expect(formatUiContext({ path: "/chat", element: null })).toBe(
      "[app context: page /chat · last active: none]",
    );
  });

  it("returns null for a missing or empty context", () => {
    expect(formatUiContext(null)).toBeNull();
    expect(formatUiContext({ path: "", element: null })).toBeNull();
  });

  it("flattens whitespace and caps long element names", () => {
    const line = formatUiContext({
      path: "/memory",
      element: { role: "link", name: `  a very ${"long ".repeat(30)}name  ` },
    });
    expect(line).not.toContain("\n");
    expect(line!.length).toBeLessThan(140);
    expect(line).toContain('link "a very long');
  });
});
