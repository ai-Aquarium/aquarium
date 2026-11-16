// @vitest-environment jsdom
/**
 * A reply row skips off-screen layout with `content-visibility: auto`, which
 * would trap a maximized panel inside the row. While the reply's SQL is
 * maximized the row drops that containment, and gets it back on minimize.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/chat/MessageBubble";

afterEach(cleanup);

const block = JSON.stringify({
  source_id: "s1",
  source: "WMS",
  version: 3,
  tables: ["shipments"],
  question: "How many?",
  sql: "SELECT count(*) FROM shipments",
  undescribed: [],
});

describe("MessageBubble — maximized data-answer SQL", () => {
  it("lifts the row's content-visibility containment only while maximized", () => {
    const view = render(
      <MessageBubble message={{ role: "assistant", content: "42 shipments.\n```data-answer\n" + block + "\n```" }} />,
    );
    const row = () => view.container.querySelector<HTMLElement>('[data-component="MessageBubble"]')!;
    expect(row().getAttribute("style")).toContain("content-visibility");

    fireEvent.click(view.getByRole("button", { name: "Show SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Maximize SQL query" }));
    expect(row().getAttribute("style") ?? "").not.toContain("content-visibility");
    expect(row().getAttribute("style") ?? "").not.toContain("contain-intrinsic-size");

    fireEvent.click(view.getByRole("button", { name: "Minimize SQL query" }));
    expect(row().getAttribute("style")).toContain("content-visibility");
  });
});
