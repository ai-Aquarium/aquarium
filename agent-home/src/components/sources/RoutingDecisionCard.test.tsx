// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RoutingDecisionCard, safeRoutingError } from "@/components/sources/RoutingDecisionCard";
import { decision } from "./fixtures";

afterEach(cleanup);

const rows = () => screen.getAllByTestId("route-choice");

describe("RoutingDecisionCard", () => {
  it("shows each profile's outcome, reason, model and the batch line (4a)", () => {
    render(<RoutingDecisionCard decision={decision()} />);
    const [cfo, cmo] = rows();
    expect(within(cfo).getByText("CFO")).toBeTruthy();
    expect(within(cfo).getByText(/INV-2291/)).toBeTruthy();
    expect(within(cfo).getByTestId("route-choice-status").textContent).toBe("Got it");
    expect(within(cmo).getByTestId("route-choice-status").textContent).toBe("Skipped");
    expect(screen.getByText(/From john@acme\.com · batch of 3 emails · \d\d:\d\d · 1 try/)).toBeTruthy();
    expect(screen.getByText("Checked by gpt-4o-mini")).toBeTruthy();
    expect(screen.getByText(/Replies always need your approval and leave through the account/)).toBeTruthy();
    expect(screen.queryByText(/only stored/)).toBeNull();
  });

  it("explains a fallback: every profile got it and why (4b)", () => {
    render(
      <RoutingDecisionCard
        decision={decision({
          fallback: true,
          attempts: 3,
          choices: [
            { profile: "CFO", selected: true, reason: "" },
            { profile: "CMO", selected: true, reason: "" },
          ],
        })}
      />,
    );
    expect(screen.getByText("The check failed 3 times, so all your routed profiles got it.")).toBeTruthy();
    expect(rows().map((r) => within(r).getByTestId("route-choice-status").textContent)).toEqual([
      "Got it · fallback",
      "Got it · fallback",
    ]);
    expect(screen.getAllByText("No reason — the check didn’t answer.")).toHaveLength(2);
    expect(screen.getByText(/3 tries/)).toBeTruthy();
  });

  it("says a batch no profile picked was only stored", () => {
    render(
      <RoutingDecisionCard
        decision={decision({
          selected: [],
          choices: [{ profile: "CFO", selected: false, reason: "Newsletter." }],
        })}
      />,
    );
    expect(screen.getByText(/only stored/)).toBeTruthy();
  });

  it("drops the parts of the batch line it doesn't have", () => {
    render(<RoutingDecisionCard decision={decision({ message_count: null, first_sender: null, decided_at: null })} />);
    expect(screen.getByText("1 try")).toBeTruthy();
  });

  it("shows only a short, plain error", () => {
    render(<RoutingDecisionCard decision={decision({ fallback: true, attempts: 3, error: "Router timed out" })} />);
    expect(screen.getByText(/Last error: Router timed out/)).toBeTruthy();
  });
});

describe("safeRoutingError", () => {
  it.each([
    [null, null],
    ["Router timed out", "Router timed out"],
    ["POST https://api.openai.com/v1/chat failed", null],
    ["Traceback (most recent call last):\n  File x", null],
    ["Invalid api key sk-abc", null],
    ["x".repeat(121), null],
  ])("%s → %s", (input, out) => {
    expect(safeRoutingError(input)).toBe(out);
  });
});
