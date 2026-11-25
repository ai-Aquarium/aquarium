// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LandingLayout } from "./LandingLayout";
import { useLandingPanels } from "./useLandingPanels";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function Harness({ tasksBadge = null, tasksUrgent = false }: { tasksBadge?: number | null; tasksUrgent?: boolean }) {
  const panels = useLandingPanels();
  return (
    <LandingLayout
      topBar={<div />}
      sidebar={<p>chat list</p>}
      main={<p>composer</p>}
      aside={<p>needs you list</p>}
      chats={{ collapsed: panels.chatsCollapsed, onCollapsedChange: panels.setChatsCollapsed }}
      tasks={{
        collapsed: panels.tasksCollapsed,
        onCollapsedChange: panels.setTasksCollapsed,
        badge: tasksBadge,
        badgeUrgent: tasksUrgent,
      }}
    />
  );
}

const grid = () => document.querySelector<HTMLElement>("[data-component=LandingLayout] > div:nth-child(2)")!;
const sidebar = () => document.querySelector<HTMLElement>('[data-component="landing-sidebar"]')!;
const aside = () => document.querySelector<HTMLElement>('[data-component="landing-aside"]')!;

describe("LandingLayout panel collapse", () => {
  it("collapses the chats panel to a rail, gives the centre the space, and expands it again", () => {
    render(<Harness />);
    expect(grid().style.gridTemplateColumns).toBe("280px minmax(0,1fr) 320px");
    fireEvent.click(screen.getByRole("button", { name: "Collapse chats panel" }));
    expect(sidebar().hidden).toBe(true);
    expect(grid().style.gridTemplateColumns).toBe("48px minmax(0,1fr) 320px");
    expect(window.localStorage.getItem("aquarium.landing.chatsCollapsed")).toBe("1");
    const expand = screen.getByRole("button", { name: "Expand chats panel" });
    expect(expand.getAttribute("title")).toBe("Expand chats panel");
    fireEvent.click(expand);
    expect(sidebar().hidden).toBe(false);
    expect(screen.queryByRole("button", { name: "Expand chats panel" })).toBeNull();
  });

  it("collapses the Needs you / tasks panel independently", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Needs you and tasks panel" }));
    expect(aside().hidden).toBe(true);
    expect(sidebar().hidden).toBe(false);
    expect(grid().style.gridTemplateColumns).toBe("280px minmax(0,1fr) 48px");
    fireEvent.click(screen.getByRole("button", { name: "Expand Needs you and tasks panel" }));
    expect(aside().hidden).toBe(false);
  });

  it("shows the needs-you count on the collapsed tasks rail", () => {
    render(<Harness tasksBadge={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Needs you and tasks panel" }));
    const rail = screen.getByRole("button", { name: "Expand Needs you and tasks panel, 7 need you" });
    expect(rail.textContent).toContain("Needs you");
    expect(rail.querySelector('[data-slot="rail-badge"]')?.textContent).toBe("7");
  });

  it("hides the tasks rail badge when nothing needs you", () => {
    render(<Harness tasksBadge={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Needs you and tasks panel" }));
    const rail = screen.getByRole("button", { name: "Expand Needs you and tasks panel" });
    expect(rail.querySelector('[data-slot="rail-badge"]')).toBeNull();
  });

  it("restores the remembered state on the next visit", () => {
    window.localStorage.setItem("aquarium.landing.chatsCollapsed", "1");
    window.localStorage.setItem("aquarium.landing.tasksCollapsed", "1");
    render(<Harness />);
    expect(sidebar().hidden).toBe(true);
    expect(aside().hidden).toBe(true);
    expect(grid().style.gridTemplateColumns).toBe("48px minmax(0,1fr) 48px");
  });
});
