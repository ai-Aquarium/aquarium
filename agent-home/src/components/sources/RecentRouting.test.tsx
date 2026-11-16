// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RecentRouting, decisionWhen } from "@/components/sources/RecentRouting";
import type { RoutingDecision, Source } from "@/types";

afterEach(cleanup);

const NOW = new Date(2026, 10, 17, 12, 0);

const src = (id: string, address: string): Source => ({
  source_id: id,
  channel: "email",
  address,
  owner_user_id: "john",
  display: null,
  credential_ref: null,
  enabled: true,
  created_at: null,
  updated_at: null,
  routes: [],
});

const d = (over: Partial<RoutingDecision>): RoutingDecision => ({
  decision_id: 1,
  batch_id: "b-1",
  source_id: "s1",
  channel: "email",
  owner_user_id: "john",
  choices: [
    { profile: "cfo", selected: false, reason: "" },
    { profile: "cmo", selected: false, reason: "" },
  ],
  selected: [],
  model: null,
  attempts: 1,
  fallback: false,
  error: null,
  decided_at: new Date(2026, 10, 17, 10, 42).toISOString(),
  message_count: null,
  first_sender: null,
  ...over,
});

describe("RecentRouting", () => {
  it("labels rows Routed, Stored only and Fallback with count and first sender", () => {
    render(
      <RecentRouting
        now={NOW}
        limit={50}
        sourceId="s1"
        sources={[src("s1", "john@acme.com"), src("s2", "+852 9123 4567")]}
        decisions={[
          d({
            decision_id: 1,
            batch_id: "b-7f3a",
            selected: ["cfo"],
            choices: [
              { profile: "cfo", selected: true, reason: "supplier invoice due Friday" },
              { profile: "cmo", selected: false, reason: "" },
            ],
            message_count: 3,
            first_sender: "ap@supplier.com",
          }),
          d({ decision_id: 2, batch_id: "b-7f0c", message_count: 1 }),
          d({ decision_id: 3, batch_id: "b-7e9d", fallback: true, attempts: 3, selected: ["cfo", "cmo"] }),
        ]}
      />,
    );
    const rows = document.querySelectorAll("tr[data-outcome]");
    expect(Array.from(rows).map((r) => r.getAttribute("data-outcome"))).toEqual(["routed", "stored", "fallback"]);
    expect(screen.getAllByText("cfo: supplier invoice due Friday").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3 messages · from ap@supplier.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 message").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No profile cares — stored only").length).toBeGreaterThan(0);
    expect(screen.getAllByText("The check failed 3 times, so all your routed profiles got it").length).toBeGreaterThan(0);
    expect(screen.getAllByText("cmo · skipped").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "john@acme.com" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "+852 9123 4567" }).getAttribute("href")).toBe("/settings/sources/s2/routing");
  });

  it("says when there are no decisions yet", () => {
    render(<RecentRouting now={NOW} limit={50} sourceId="s1" sources={[src("s1", "a@b.co")]} decisions={[]} />);
    expect(screen.getByTestId("routing-empty")).toBeTruthy();
  });

  it("formats when: time today, Yesterday, else date", () => {
    expect(decisionWhen(null, NOW, "Yesterday")).toBe("—");
    expect(decisionWhen(new Date(2026, 10, 16, 9, 0).toISOString(), NOW, "Yesterday")).toBe("Yesterday");
    expect(decisionWhen(new Date(2026, 10, 17, 9, 5).toISOString(), NOW, "Yesterday")).toMatch(/09:05/);
  });
});
