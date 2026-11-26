import { describe, expect, it } from "vitest";

import type { PlaybookStep } from "@/types";

import { draftChanges, draftOwner, quoteForChat } from "./draftDiff";

const step = (key: string, extra: Partial<PlaybookStep> = {}): PlaybookStep => ({
  key,
  title: key,
  depends_on: [],
  ...extra,
});

describe("draftChanges", () => {
  it("marks the draft's new and edited content against its base", () => {
    const base = { body: "Every Monday.\nDedupe rows.", steps: [step("pull"), step("clean"), step("send")] };
    const draft = {
      body: "Every Monday.\nIf the export is late, wait until 10:45.\nDedupe rows.",
      steps: [step("wait"), step("pull", { depends_on: ["wait"] }), step("clean")],
    };
    const c = draftChanges(base, draft);
    expect(c.paragraphs).toEqual([
      { text: "Every Monday.", changed: false },
      { text: "If the export is late, wait until 10:45.", changed: true },
      { text: "Dedupe rows.", changed: false },
    ]);
    expect([...c.steps]).toEqual([
      ["wait", "added"],
      ["pull", "changed"],
    ]);
    expect(c.removed.map((s) => s.key)).toEqual(["send"]);
    expect(c.count).toBe(4);
  });

  it("finds nothing changed in an untouched draft", () => {
    const base = { body: "Once.", steps: [step("pull")] };
    expect(draftChanges(base, { ...base }).count).toBe(0);
  });

  it("treats stored defaults as unchanged but a real tool or mode change as changed", () => {
    const base = { steps: [step("pull"), step("clean"), step("send")] };
    const draft = {
      steps: [
        step("pull", { toolsets: [], mode: "card" }),
        step("clean", { toolsets: ["web"] }),
        step("send", { mode: "inline" }),
      ],
    };
    expect([...draftChanges(base, draft).steps]).toEqual([
      ["clean", "changed"],
      ["send", "changed"],
    ]);
  });

  it("treats every part of a draft from scratch as new", () => {
    const c = draftChanges(null, { body: "New plan.", steps: [step("pull")] });
    expect(c.paragraphs[0].changed).toBe(true);
    expect(c.steps.get("pull")).toBe("added");
  });
});

describe("quoteForChat", () => {
  it("quotes every line under a bold source label", () => {
    expect(quoteForChat("v5 · step 2", "Pull the export\nfrom the CRM")).toBe(
      "> **v5 · step 2**\n> Pull the export\n> from the CRM\n\n",
    );
  });
});

describe("draftOwner", () => {
  it("names the owner by display name, falling back to the user id", () => {
    expect(draftOwner({ user_id: "u-1", display_name: "Leo" })).toBe("Leo");
    expect(draftOwner({ user_id: "u-1", display_name: null })).toBe("u-1");
    expect(draftOwner({ user_id: "u-1", display_name: "  " })).toBe("u-1");
    expect(draftOwner({ user_id: "u-1" })).toBe("u-1");
  });
});
