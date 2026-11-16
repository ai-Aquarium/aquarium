// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Maximizable, MaximizeToggle } from "./Maximizable";
import { Sheet } from "./Sheet";

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <button type="button">Background</button>
      {open ? (
        <Sheet title="Panel" onClose={() => setOpen(false)}>
          <button type="button">Inside</button>
        </Sheet>
      ) : null}
    </div>
  );
}

const flushFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe("Sheet", () => {
  it("renders on body, keeps Tab inside and returns focus to the opener", async () => {
    const { container } = render(<Harness />);
    const opener = screen.getByText("Open sheet");
    opener.focus();
    fireEvent.click(opener);
    await flushFrame();

    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);

    const close = screen.getByLabelText("Close");
    const inside = screen.getByText("Inside");
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inside);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the opener when a child autofocuses", async () => {
    function AutoHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open form
          </button>
          {open ? (
            <Sheet title="Form" onClose={() => setOpen(false)}>
              <input aria-label="Name" autoFocus />
            </Sheet>
          ) : null}
        </div>
      );
    }
    render(<AutoHarness />);
    const opener = screen.getByText("Open form");
    opener.focus();
    fireEvent.click(opener);
    await flushFrame();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open sheet"));
    await flushFrame();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Sheet with a maximized panel inside", () => {
  function WithPanel() {
    const [open, setOpen] = useState(true);
    return open ? (
      <Sheet title="File" onClose={() => setOpen(false)}>
        <Maximizable title="notes.txt">
          <MaximizeToggle />
          <pre>text</pre>
        </Maximizable>
      </Sheet>
    ) : null;
  }

  it("Esc minimizes the panel first, then closes the sheet", async () => {
    render(<WithPanel />);
    await flushFrame();
    fireEvent.click(screen.getByRole("button", { name: "Maximize notes.txt" }));
    expect(screen.getByRole("dialog", { name: "notes.txt" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "notes.txt" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "File" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives page scrolling back when the sheet unmounts with the panel still maximized", async () => {
    const { unmount } = render(<WithPanel />);
    await flushFrame();
    fireEvent.click(screen.getByRole("button", { name: "Maximize notes.txt" }));
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
