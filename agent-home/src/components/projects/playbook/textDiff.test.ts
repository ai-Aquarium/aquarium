import { describe, expect, it } from "vitest";

import { paragraphs, textDiff } from "@/components/projects/playbook/textDiff";

describe("textDiff", () => {
  it("keeps shared paragraphs and marks the rest removed (older) or added (newer)", () => {
    const d = textDiff(
      "Pull the CRM export.\nClean the rows.\nReconcile targets.",
      "Pull the CRM export.\nClean the rows and dedupe by opportunity_id.\nReconcile targets.\nFlag outliers.",
    );
    expect(d.before.map((r) => r.kind)).toEqual(["same", "removed", "same"]);
    expect(d.after.map((r) => r.kind)).toEqual(["same", "added", "same", "added"]);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    expect(d.unchanged).toBe(false);
  });

  it("each side reproduces its own text in order, whatever the diff", () => {
    const a = "One\n\nTwo\nThree";
    const b = "Three\nOne\nFour";
    const d = textDiff(a, b);
    expect(d.before.map((r) => r.text)).toEqual(paragraphs(a));
    expect(d.after.map((r) => r.text)).toEqual(paragraphs(b));
    // What both sides keep is the same sequence.
    expect(d.before.filter((r) => r.kind === "same").map((r) => r.text)).toEqual(
      d.after.filter((r) => r.kind === "same").map((r) => r.text),
    );
  });

  it("ignores blank lines and surrounding whitespace", () => {
    expect(textDiff("  Plan it.\n\n", "Plan it.").unchanged).toBe(true);
    expect(textDiff(null, "").unchanged).toBe(true);
    expect(textDiff(null, "New.").after).toEqual([{ kind: "added", text: "New." }]);
  });
});
