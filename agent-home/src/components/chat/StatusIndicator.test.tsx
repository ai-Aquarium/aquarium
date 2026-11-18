// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LONG_TASK_HINT_MS,
  STALL_WARNING_MS,
  StatusIndicator,
} from "@/components/chat/StatusIndicator";
import { I18nProvider } from "@/i18n";
import { readLocaleFiles } from "@/i18n/load";

const sel = (c: Element, name: string) =>
  c.querySelector(`[data-component="${name}"]`);

describe("StatusIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing when idle", () => {
    const { container } = render(<StatusIndicator activity="idle" />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps the explicit elapsedMs/quietMs API", () => {
    const { container } = render(
      <StatusIndicator activity="tool" detail="terminal" elapsedMs={65_000} quietMs={0} />,
    );
    const root = sel(container, "StatusIndicator")!;
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("data-activity")).toBe("tool");
    expect(root.textContent).toContain("Running terminal…");
    expect(sel(container, "StatusElapsed")!.textContent).toBe("1:05");
    expect(sel(container, "StatusLongTaskHint")).not.toBeNull();
  });

  it("ticks its own clock from startedAt", () => {
    const t0 = Date.now();
    const { container } = render(
      <StatusIndicator activity="thinking" startedAt={t0} lastEventAt={t0} />,
    );
    expect(sel(container, "StatusElapsed")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(sel(container, "StatusElapsed")!.textContent).toBe("0:02");
    act(() => {
      vi.advanceTimersByTime(LONG_TASK_HINT_MS);
    });
    expect(sel(container, "StatusLongTaskHint")).not.toBeNull();
  });

  it("computes quiet time from lastEventAt for the stall warning", () => {
    const t0 = Date.now();
    const { container } = render(
      <StatusIndicator activity="streaming" hasOutput startedAt={t0} lastEventAt={t0} />,
    );
    expect(sel(container, "StatusStallWarning")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(STALL_WARNING_MS + 1000);
    });
    expect(sel(container, "StatusStallWarning")).not.toBeNull();
  });

  it("shows the stopping hint", () => {
    const { container } = render(
      <StatusIndicator activity="stopping" startedAt={Date.now()} />,
    );
    expect(sel(container, "StatusStoppingHint")).not.toBeNull();
  });

  it("renders a compact inline line without the pill box", () => {
    const { container } = render(
      <StatusIndicator activity="thinking" compact startedAt={Date.now()} />,
    );
    const root = sel(container, "StatusIndicator")!;
    expect(root.getAttribute("data-compact")).toBe("true");
    expect(root.innerHTML).not.toContain("rounded-2xl border");
    expect(root.innerHTML).toContain("text-xs");
    expect(root.textContent).toContain("thinking");
  });

  it("names the answering profile while thinking and writing", () => {
    const { container, rerender } = render(
      <StatusIndicator activity="thinking" profileName="finance" />,
    );
    const root = () => sel(container, "StatusIndicator")!;
    expect(root().textContent).toContain("Agent finance is thinking…");
    rerender(<StatusIndicator activity="streaming" profileName="finance" />);
    expect(root().textContent).toContain("Agent finance is writing…");
    rerender(<StatusIndicator activity="thinking" profileName="hr" />);
    expect(root().textContent).toContain("Agent hr is thinking…");
    expect(root().textContent).not.toContain("a4all");
  });

  it("falls back to a nameless agent without a profile", () => {
    for (const profileName of [undefined, "", "  "]) {
      const { container, unmount } = render(
        <StatusIndicator activity="thinking" profileName={profileName} />,
      );
      const text = sel(container, "StatusIndicator")!.textContent ?? "";
      expect(text).toContain("Agent is thinking…");
      expect(text).not.toContain("a4all");
      unmount();
    }
  });

  it("renders the zh-Hant label with the profile name", () => {
    const { container } = render(
      <I18nProvider locale="zh-Hant" messages={readLocaleFiles("zh-Hant")}>
        <StatusIndicator activity="thinking" profileName="finance" />
      </I18nProvider>,
    );
    expect(sel(container, "StatusIndicator")!.textContent).toContain(
      "代理 finance 正在思考…",
    );
  });
});
