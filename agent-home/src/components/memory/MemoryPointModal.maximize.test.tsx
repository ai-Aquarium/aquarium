// @vitest-environment jsdom
/**
 * A memory's text in the point modal can be maximized to the full screen.
 * Esc minimizes the text first; the next Esc closes the modal.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryProjectionPoint } from "@/types";

import { MemoryPointModal } from "./MemoryMap";

afterEach(cleanup);

const POINT: MemoryProjectionPoint = {
  id: "p1",
  x: 0.1,
  y: 0.2,
  owner_user_id: "leo_owner",
  topic: "pricing",
  kind: "memory",
  elevated: false,
  provenance: "",
  label: "Enterprise seats above 250 get 22% off.",
};

const panel = () => document.querySelector<HTMLElement>('[data-component="MemoryPointText"]')!;
const text = () => panel().querySelector<HTMLElement>("p")!;

describe("MemoryPointModal text — maximize", () => {
  it("keeps the capped text until maximized, then uses the full height", () => {
    const view = render(<MemoryPointModal point={POINT} onClose={() => {}} />);
    expect(text().textContent).toBe(POINT.label);
    expect(text().className).toContain("max-h-60");
    fireEvent.click(view.getByRole("button", { name: "Maximize Memory" }));
    expect(panel().getAttribute("data-maximized")).toBe("true");
    expect(text().className).not.toContain("max-h-60");
    expect(text().className).toContain("flex-1");
    fireEvent.click(view.getByRole("button", { name: "Minimize Memory" }));
    expect(panel().getAttribute("data-maximized")).toBe("false");
    expect(text().className).toContain("max-h-60");
  });

  it("Esc minimizes the text first, then closes the modal", () => {
    const onClose = vi.fn();
    const view = render(<MemoryPointModal point={POINT} onClose={onClose} />);
    fireEvent.click(view.getByRole("button", { name: "Maximize Memory" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(panel().getAttribute("data-maximized")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc still closes the modal when the text was never maximized", () => {
    const onClose = vi.fn();
    render(<MemoryPointModal point={POINT} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
