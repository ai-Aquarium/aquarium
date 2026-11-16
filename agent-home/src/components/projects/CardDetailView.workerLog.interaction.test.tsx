// @vitest-environment jsdom
/**
 * A running card's worker log can be maximized to the full screen to read
 * it, and minimized back (button or Esc) to the same small box.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { CardDetailView } from "@/components/projects/CardDetailView";
import type { ProjectCardDetail } from "@/types";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CARD = {
  id: "t_7",
  title: "Collect the tender documents",
  body: "",
  status: "running",
  assignee: "default",
  priority: 0,
  created_at: 1,
  started_at: 1,
  completed_at: null,
  tenant: null,
  project_id: "prj_1",
  result: null,
  current_step_key: null,
  latest_summary: null,
  comments: [],
  worker_log_tail: "fetching tender pack\nsaved 3 files",
} as unknown as ProjectCardDetail;

const log = () => document.querySelector<HTMLElement>('[data-component="CardWorkerLog"]')!;
const panel = () => document.querySelector<HTMLElement>('[data-component="CardWorkerLogPanel"]')!;

describe("CardDetailView worker log — maximize", () => {
  it("keeps the small capped box until maximized", () => {
    const view = render(<CardDetailView slug="tender" card={CARD} />);
    expect(log().textContent).toContain("saved 3 files");
    expect(log().className).toContain("max-h-72");
    expect(panel().getAttribute("data-maximized")).toBe("false");
    expect(view.getByRole("button", { name: "Maximize Worker log" }).textContent).toBe("⤢ Maximize");
  });

  it("maximizes to full height and minimizes back with the button or Esc", () => {
    const view = render(<CardDetailView slug="tender" card={CARD} />);
    fireEvent.click(view.getByRole("button", { name: "Maximize Worker log" }));
    expect(panel().getAttribute("data-maximized")).toBe("true");
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(log().className).not.toContain("max-h-72");
    expect(log().className).toContain("flex-1");
    expect(view.queryByRole("button", { name: "Maximize Worker log" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Minimize Worker log" }));
    expect(panel().getAttribute("data-maximized")).toBe("false");
    expect(log().className).toContain("max-h-72");

    fireEvent.click(view.getByRole("button", { name: "Maximize Worker log" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(panel().getAttribute("data-maximized")).toBe("false");
    expect(document.querySelector('[data-component="CardProgress"]')).toBeTruthy();
  });
});
