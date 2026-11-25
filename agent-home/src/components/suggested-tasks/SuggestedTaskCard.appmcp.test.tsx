// @vitest-environment jsdom
/**
 * The incident question "What does the Snooze button do?" must be answerable
 * from app_describe_page alone: the card's Snooze reports which card it is
 * (section) and what it does (hint), straight from the rendered DOM.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { snapshotElements } from "@/lib/app-mcp/snapshot";
import { SNOOZE_OPTIONS } from "@/lib/suggested-tasks/channels";
import type { SuggestedTask, Todo } from "@/types";

import { SuggestedTaskCard } from "./SuggestedTaskCard";

const TASK: SuggestedTask = {
  channel: "email",
  todo: { id: "88", ref: "D88", title: "Reply to Ada", description: "", stage: "open", priority: "normal" } as Todo,
  source: null,
};

afterEach(cleanup);

function renderCard() {
  render(
    <SuggestedTaskCard
      task={TASK}
      onWork={vi.fn()}
      onSnooze={vi.fn(async () => {})}
      onDismiss={vi.fn(async () => {})}
      onDetails={vi.fn()}
    />,
  );
}

describe("SuggestedTaskCard in the app-mcp snapshot", () => {
  it("gives every card action the card's section and a hint", () => {
    renderCard();
    const byName = new Map(snapshotElements(document).map((e) => [e.name, e]));
    for (const name of ["Reply to Ada", "Work on this", "Snooze", "Dismiss"]) {
      const entry = byName.get(name);
      expect(entry?.section, name).toBe("SuggestedTaskCard: Reply to Ada");
      expect(entry?.hint, name).toBeTruthy();
    }
    const snooze = byName.get("Snooze")!.hint!;
    for (const option of SNOOZE_OPTIONS) expect(snooze).toContain(option.label);
  });

  it("names the duration on each snooze menu item", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    const items = snapshotElements(document).filter((e) => e.role === "menuitem");
    expect(items.map((e) => e.name)).toEqual(SNOOZE_OPTIONS.map((o) => o.label));
    for (const [i, item] of items.entries()) {
      expect(item.section).toBe("Snooze for");
      expect(item.hint).toContain(SNOOZE_OPTIONS[i].label);
    }
  });
});
