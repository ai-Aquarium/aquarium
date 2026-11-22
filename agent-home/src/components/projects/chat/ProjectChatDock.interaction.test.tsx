// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectChatDock, useChatDock } from "@/components/projects/chat/ProjectChatDock";
import { dockStorageKey } from "@/components/projects/chat/dockState";

function Harness({ phoneOpen = false, count = 0 }: { phoneOpen?: boolean; count?: number }) {
  const [state, dispatch] = useChatDock("leo");
  return (
    <ProjectChatDock state={state} dispatch={dispatch} profile="finance" phoneOpen={phoneOpen}>
      {(onMessageCount) => (
        <button type="button" data-testid="chat" onClick={() => onMessageCount(count)}>
          chat
        </button>
      )}
    </ProjectChatDock>
  );
}

const dock = (r: ReturnType<typeof render>) =>
  r.container.querySelector('[data-component="ProjectChatDock"]') as HTMLElement;
const key = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", init)));

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ProjectChatDock", () => {
  it("maximizes, restores and minimizes from the header, and remembers the mode per person", () => {
    const r = render(<Harness />);
    expect(dock(r).dataset.mode).toBe("open");
    fireEvent.click(r.getByRole("button", { name: "Maximize chat" }));
    expect(dock(r).dataset.mode).toBe("max");
    expect(r.getByRole("button", { name: "Show project" })).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Restore chat" }));
    expect(dock(r).dataset.mode).toBe("open");
    fireEvent.click(r.getByRole("button", { name: "Minimize chat" }));
    expect(dock(r).dataset.mode).toBe("min");
    expect(JSON.parse(window.localStorage.getItem(dockStorageKey("leo")) ?? "{}").mode).toBe("min");
    fireEvent.click(r.getByRole("button", { name: "Open chat" }));
    expect(dock(r).dataset.mode).toBe("open");
  });

  it("keeps one chat mounted across modes", () => {
    const r = render(<Harness />);
    const chat = r.getByTestId("chat");
    fireEvent.click(r.getByRole("button", { name: "Maximize chat" }));
    fireEvent.click(r.getByRole("button", { name: "Restore chat" }));
    fireEvent.click(r.getByRole("button", { name: "Minimize chat" }));
    expect(r.getByTestId("chat")).toBe(chat);
  });

  it("toggles with Ctrl/Cmd+. and Ctrl/Cmd+Shift+., and Esc restores a maximized chat", () => {
    const r = render(<Harness />);
    key({ key: ".", ctrlKey: true });
    expect(dock(r).dataset.mode).toBe("min");
    key({ key: ".", metaKey: true });
    expect(dock(r).dataset.mode).toBe("open");
    key({ key: ">", code: "Period", ctrlKey: true, shiftKey: true });
    expect(dock(r).dataset.mode).toBe("max");
    key({ key: "Escape" });
    expect(dock(r).dataset.mode).toBe("open");
    key({ key: "Escape" });
    expect(dock(r).dataset.mode).toBe("open");
  });

  it("counts messages that arrive while minimized on the rail", () => {
    const { rerender, ...r } = render(<Harness count={2} />);
    fireEvent.click(r.getByTestId("chat"));
    fireEvent.click(r.getByRole("button", { name: "Minimize chat" }));
    rerender(<Harness count={5} />);
    fireEvent.click(r.getByTestId("chat"));
    expect(r.getByRole("button", { name: "Open chat, 3 unread" })).toBeTruthy();
  });

  it("resizes by dragging the handle, within limits", () => {
    const r = render(<Harness />);
    const handle = r.getByRole("separator", { name: "Resize chat" });
    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 900, pointerId: 1 });
    expect(JSON.parse(window.localStorage.getItem(dockStorageKey("leo")) ?? "{}").width).toBe(500);
    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 0, pointerId: 1 });
    expect(JSON.parse(window.localStorage.getItem(dockStorageKey("leo")) ?? "{}").width).toBe(640);
  });
});
