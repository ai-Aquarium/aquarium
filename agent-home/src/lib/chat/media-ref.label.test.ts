import { describe, expect, it } from "vitest";

import { attachmentLink, escapeLinkLabel, unescapeLinkLabel } from "@/lib/chat/media-ref";

describe("attachment link labels", () => {
  it("escapes what would end the link text early, and reads it back", () => {
    for (const name of ["[Q4](final copy).pdf", "a]b.pdf", "x\\y (1).png", "plain.txt"]) {
      const label = escapeLinkLabel(name);
      expect(label).not.toMatch(/(^|[^\\])[[\]()]/);
      expect(unescapeLinkLabel(label)).toBe(name);
    }
  });

  it("leaves a name stored before escaping as it was", () => {
    expect(unescapeLinkLabel("draft [v2].pdf")).toBe("draft [v2].pdf");
    expect(unescapeLinkLabel("C:\\notes.txt")).toBe("C:\\notes.txt");
  });

  it("builds an image or file link around the escaped name", () => {
    expect(attachmentLink("[Q4](final).png", "u/s/a.png", true)).toBe(
      "![\\[Q4\\]\\(final\\).png](/api/chat/media?path=u%2Fs%2Fa.png)",
    );
    expect(attachmentLink("r.pdf", "u/s/r.pdf", false)).toBe(
      "[r.pdf](/api/chat/media?path=u%2Fs%2Fr.pdf)",
    );
  });
});
