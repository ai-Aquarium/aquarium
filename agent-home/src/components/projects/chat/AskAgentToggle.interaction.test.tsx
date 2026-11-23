// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { AskAgentToggle } from "@/components/projects/chat/ProjectChatPanel";

afterEach(cleanup);

describe("AskAgentToggle", () => {
  it("is a 44px switch that says who reads the message either way", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AskAgentToggle on profile="research" onChange={onChange} />);
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.className).toContain("min-h-[44px]");
    expect(screen.getByText(/research/)).toBeTruthy();
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(false);

    rerender(<AskAgentToggle on={false} profile="research" onChange={onChange} />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/research answers/)).toBeNull();
  });
});
