import { describe, expect, it } from "vitest";

import { splitProjectCards } from "@/lib/chat/project-card";

describe("splitProjectCards", () => {
  it("takes the card line out of the reply", () => {
    const out = splitProjectCards(
      "Created P12 and proposed playbook v1.\n\n[project card: weekly-sales P12 quoted]",
    );
    expect(out.text).toBe("Created P12 and proposed playbook v1.");
    expect(out.cards).toEqual([{ slug: "weekly-sales", ref: "P12", quoted: true }]);
  });

  it("reads a card without a ref or a quote", () => {
    expect(splitProjectCards("[project card: digest]").cards).toEqual([
      { slug: "digest", ref: null, quoted: false },
    ]);
  });

  it("leaves a mention inside a sentence or a code block alone", () => {
    const text = "The line looks like [project card: x P1].\n```\n[project card: y P2]\n```";
    expect(splitProjectCards(text)).toEqual({ text, cards: [] });
  });

  it("draws one card per project", () => {
    const out = splitProjectCards("[project card: a P1]\n[project card: a P1]");
    expect(out.cards).toHaveLength(1);
  });
});
