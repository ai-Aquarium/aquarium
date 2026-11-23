// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerPrefillContext } from "@/components/chat/composerPrefill";
import { OptionCards } from "@/components/chat/OptionCards";

const OPTIONS = [
  { label: "A", title: "Stop and tell Leo", pros: ["Never uses stale data"], cons: ["No report that week"] },
  { label: "B", title: "Wait until a cut-off", pros: [], cons: ["Runs longer"] },
];

afterEach(cleanup);

describe("OptionCards", () => {
  it("puts the picked option in the composer", () => {
    const prefill = vi.fn();
    render(
      <ComposerPrefillContext.Provider value={prefill}>
        <OptionCards options={OPTIONS} />
      </ComposerPrefillContext.Provider>,
    );
    expect(screen.getByText("Never uses stale data")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick B" }));
    expect(prefill).toHaveBeenCalledWith("Option B: Wait until a cut-off");
  });

  it("shows the options without Pick where nobody can post", () => {
    render(<OptionCards options={OPTIONS} />);
    expect(screen.getByText("Stop and tell Leo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pick/ })).toBeNull();
  });
});
