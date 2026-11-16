// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Maximizable, MaximizeToggle, useMaximizable } from "./Maximizable";
import { Sheet } from "./Sheet";

afterEach(cleanup);

const flushFrame = () =>
  act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

function Counter() {
  const [n, setN] = useState(0);
  const { maximized } = useMaximizable();
  return (
    <button
      type="button"
      data-maximized-child={maximized ? "yes" : "no"}
      onClick={() => setN(n + 1)}
    >
      count {n}
    </button>
  );
}

function Panel({ onChange }: { onChange?(next: boolean): void }) {
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <button type="button">Outside</button>
      <Maximizable
        title="Ask about this project"
        status="Working"
        aria-label="Ask or change"
        className="rounded-2xl p-3"
        onMaximizedChange={onChange}
      >
        <div>
          <span>Tabs</span>
          <MaximizeToggle />
        </div>
        <textarea aria-label="Your question" />
        <Counter />
        <button type="button" onClick={() => setSheet(true)}>
          Open sheet
        </button>
      </Maximizable>
      {sheet ? (
        <Sheet title="Change" onClose={() => setSheet(false)}>
          <input aria-label="In sheet" />
        </Sheet>
      ) : null}
    </>
  );
}

const panel = () => document.querySelector<HTMLElement>("[data-maximizable]")!;
const esc = (
  el: Element = document.activeElement ?? document.body,
  init: KeyboardEventInit = {},
) => fireEvent.keyDown(el, { key: "Escape", ...init });

describe("Maximizable", () => {
  it("maximizes and minimizes without remounting the content", () => {
    render(<Panel />);
    const textarea = screen.getByLabelText(
      "Your question",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft question" } });
    fireEvent.click(screen.getByText("count 0"));
    expect(panel().getAttribute("role")).toBeNull();
    expect(panel().getAttribute("aria-label")).toBe("Ask or change");

    fireEvent.click(
      screen.getByRole("button", { name: "Maximize Ask about this project" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Ask about this project",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.className).toContain("fixed inset-0");
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.queryByText("⤢ Maximize")).toBeNull();
    expect(screen.getByLabelText("Your question")).toBe(textarea);
    expect(textarea.value).toBe("draft question");
    expect(
      screen.getByText("count 1").getAttribute("data-maximized-child"),
    ).toBe("yes");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByText("⤡ Minimize"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Your question")).toBe(textarea);
    expect(textarea.value).toBe("draft question");
    expect(
      screen.getByText("count 1").getAttribute("data-maximized-child"),
    ).toBe("no");
    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus between Maximize and Minimize, and leaves it in a field on Esc", () => {
    render(<Panel />);
    const toggle = screen.getByText("⤢ Maximize");
    toggle.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(screen.getByText("⤡ Minimize"));
    fireEvent.click(screen.getByText("⤡ Minimize"));
    expect(document.activeElement).toBe(screen.getByText("⤢ Maximize"));

    fireEvent.click(screen.getByText("⤢ Maximize"));
    const textarea = screen.getByLabelText("Your question");
    textarea.focus();
    esc(textarea);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it("Esc closes a Sheet opened above it first, then minimizes", async () => {
    render(<Panel />);
    fireEvent.click(screen.getByText("⤢ Maximize"));
    fireEvent.click(screen.getByText("Open sheet"));
    await flushFrame();
    const inSheet = screen.getByLabelText("In sheet");
    inSheet.focus();

    esc(inSheet);
    expect(screen.queryByLabelText("In sheet")).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Ask about this project" }),
    ).toBeTruthy();

    esc();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores Esc during IME composition or when an inner widget handled it", () => {
    render(<Panel />);
    fireEvent.click(screen.getByText("⤢ Maximize"));
    const textarea = screen.getByLabelText("Your question");
    esc(textarea, { isComposing: true });
    expect(screen.getByRole("dialog")).toBeTruthy();

    textarea.addEventListener("keydown", (e) => e.preventDefault(), {
      once: true,
    });
    esc(textarea);
    expect(screen.getByRole("dialog")).toBeTruthy();

    esc(textarea);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the maximized panel", () => {
    render(<Panel />);
    fireEvent.click(screen.getByText("⤢ Maximize"));
    const minimize = screen.getByText("⤡ Minimize");
    const last = screen.getByText("Open sheet");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(minimize);
    fireEvent.keyDown(minimize, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    screen.getByText("Outside").focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(minimize);
  });

  it("only the most recently maximized panel answers Esc", () => {
    render(
      <>
        <Maximizable title="A" defaultMaximized>
          <span>a</span>
        </Maximizable>
        <Maximizable title="B" defaultMaximized>
          <span>b</span>
        </Maximizable>
      </>,
    );
    esc(document.body);
    expect(screen.queryByRole("dialog", { name: "B" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "A" })).toBeTruthy();
    esc(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("supports controlled use and render-prop children", () => {
    const onChange = vi.fn();
    function Controlled() {
      const [max, setMax] = useState(false);
      return (
        <Maximizable
          title="Activity"
          maximized={max}
          onMaximizedChange={(next) => {
            onChange(next);
            setMax(next);
          }}
        >
          {({ maximized }) => (
            <>
              <MaximizeToggle />
              <p>{maximized ? "big" : "small"}</p>
            </>
          )}
        </Maximizable>
      );
    }
    render(<Controlled />);
    expect(screen.getByText("small")).toBeTruthy();
    fireEvent.click(screen.getByText("⤢ Maximize"));
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("big")).toBeTruthy();
    esc(document.body);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("small")).toBeTruthy();
  });
});
