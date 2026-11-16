// @vitest-environment jsdom
/**
 * The SQL behind a data answer opens in a small box that can be maximized to
 * the full screen and minimized back (button or Esc).
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DataAnswer } from "@/lib/chat/data-answer";

import { DataAnswerFooter } from "./DataAnswerFooter";

afterEach(cleanup);

const ANSWER: DataAnswer = {
  source_id: "src_1",
  source: "Sales DB",
  version: 3,
  tables: ["orders"],
  sql: "SELECT count(*) FROM orders",
  question: "How many orders?",
  undescribed: [],
};

const pre = () => document.querySelector<HTMLElement>('[data-component="DataAnswerSql"] pre')!;
const panel = () => document.querySelector<HTMLElement>('[data-component="DataAnswerSql"]')!;

describe("DataAnswerFooter SQL — maximize", () => {
  it("shows no Maximize until the SQL is open", () => {
    const view = render(<DataAnswerFooter answer={ANSWER} />);
    expect(view.queryByRole("button", { name: /^Maximize/ })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Show SQL" }));
    expect(pre().textContent).toBe("SELECT count(*) FROM orders");
    expect(pre().className).toContain("max-h-64");
    expect(view.getByRole("button", { name: "Maximize SQL query" }).textContent).toBe("⤢ Maximize");
    expect(document.querySelector('[data-component="DataAnswerFooter"]')).toBeTruthy();
  });

  it("maximizes to full height and minimizes back with the button or Esc", () => {
    const view = render(<DataAnswerFooter answer={ANSWER} />);
    fireEvent.click(view.getByRole("button", { name: "Show SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Maximize SQL query" }));
    expect(panel().getAttribute("data-maximized")).toBe("true");
    expect(pre().className).not.toContain("max-h-64");
    expect(pre().className).toContain("flex-1");
    expect(pre().getAttribute("tabindex")).toBe("0");
    expect(pre().getAttribute("aria-label")).toBe("SQL query");

    fireEvent.click(view.getByRole("button", { name: "Minimize SQL query" }));
    expect(panel().getAttribute("data-maximized")).toBe("false");
    expect(pre().className).toContain("max-h-64");

    fireEvent.click(view.getByRole("button", { name: "Maximize SQL query" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(panel().getAttribute("data-maximized")).toBe("false");
    expect(pre().textContent).toBe("SELECT count(*) FROM orders");
  });
});
