import { describe, expect, it } from "vitest";

import { viewerBack, viewerFileId, viewerHref } from "@/lib/nav/viewer-back";

describe("viewer Back target", () => {
  it("returns to the in-app page it was opened from", () => {
    expect(viewerBack("/chat?session=s1")).toEqual({ href: "/chat?session=s1", label: "Chat" });
    expect(viewerBack("/files")).toEqual({ href: "/files", label: "Files" });
  });

  it("falls back to Files for anything that is not an agent-home page", () => {
    for (const bad of [
      undefined,
      "",
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "/api/files/a/content",
      "/view/other",
      "javascript:alert(1)",
      `/${"x".repeat(600)}`,
    ]) {
      expect(viewerBack(bad)).toEqual({ href: "/files", label: "Files" });
    }
  });

  it("round-trips a viewer link", () => {
    const href = viewerHref("a b", "/chat?session=1");
    expect(href).toBe("/view/a%20b?from=%2Fchat%3Fsession%3D1");
    expect(viewerFileId(href)).toBe("a b");
    expect(viewerFileId("/view/x")).toBe("x");
    expect(viewerFileId("/viewer/x")).toBeNull();
    expect(viewerFileId("https://other.example/view/x")).toBeNull();
  });
});
