import { describe, expect, it } from "vitest";

import { optionReply, splitOptionCards } from "./option-cards";

const BLOCK = [
  "Three ways to handle a late export:",
  "",
  "```options",
  JSON.stringify([
    { label: "A", title: "Stop and tell Leo", pros: ["Never uses stale data"], cons: ["No report that week"] },
    { title: "Wait and retry until a cut-off", pros: ["Lands before noon"], cons: [] },
  ]),
  "```",
  "",
  "Or tell me what you prefer.",
].join("\n");

describe("splitOptionCards", () => {
  it("lifts a JSON options block out of the reply", () => {
    const { text, options } = splitOptionCards(BLOCK);
    expect(text).toBe("Three ways to handle a late export:\n\nOr tell me what you prefer.");
    expect(options.map((o) => [o.label, o.title])).toEqual([
      ["A", "Stop and tell Leo"],
      ["B", "Wait and retry until a cut-off"],
    ]);
    expect(options[0].cons).toEqual(["No report that week"]);
  });

  it("leaves a reply without a well-formed block untouched", () => {
    const broken = "```options\nnot json\n```";
    expect(splitOptionCards(broken)).toEqual({ text: broken, options: [] });
    const titleless = '```options\n[{"label": "A"}]\n```';
    expect(splitOptionCards(titleless).options).toEqual([]);
    expect(splitOptionCards("plain text").options).toEqual([]);
  });

  it("turns a pick into a reply naming the option", () => {
    const [a] = splitOptionCards(BLOCK).options;
    expect(optionReply(a)).toBe("Option A: Stop and tell Leo");
  });
});
