// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { SeedNote } from "@/components/projects/chat/ProjectChatPanel";
import { timelineMessages } from "@/components/projects/chat/projectTimeline";

const seed = {
  summary: "A weekly sales report.",
  quotes: [{ text: "Every Monday 8am, build the report.\nReconcile it with FY26 targets." }],
};

afterEach(cleanup);

describe("SeedNote", () => {
  it("labels the quote as the creator's request from a private chat", () => {
    const r = render(<SeedNote person="Leo" seed={seed} />);
    expect(r.getByText("Started from Leo's private chat")).toBeTruthy();
    expect(r.getByText("Leo's original request")).toBeTruthy();
    const quote = r.container.querySelector("[data-component=ProjectChatSeedQuote]");
    expect(quote?.textContent).toBe(seed.quotes[0].text);
    expect(r.queryByRole("link")).toBeNull();
  });

  it("links the creator back to the private chat", () => {
    const r = render(
      <SeedNote person="Leo" seed={{ ...seed, origin: { ref: "C1024", url: "/chat?session=s1&profile=default" } }} />,
    );
    const link = r.getByRole("link", { name: /Open original chat/ });
    expect(link.getAttribute("href")).toBe("/chat?session=s1&profile=default");
    expect(r.container.textContent).toContain("only you can open it");
  });

  it("is drawn as the note, not as a bubble, in the timeline", () => {
    const [row] = timelineMessages({
      sessions: [],
      truncated: false,
      proposals: [],
      last_profile: null,
      messages: [
        {
          id: "m1", role: "user", content: "Started from Leo's private chat.", timestamp: 1,
          profile: null, session_id: null, person: "leo", member_only: true, seed,
        },
      ],
    });
    expect(row.content).toBe("");
    expect(row.seedNote).toEqual(seed);
    expect(row.memberOnly).toBe(true);
  });
});
