import { describe, expect, it } from "vitest";

import { layerBadge, layerNote, newFileKey, offByTemplate, triageUrl } from "@/lib/triage/layers";
import type { TriageLayeredFile } from "@/types";

const file = (over: Partial<TriageLayeredFile>): TriageLayeredFile => ({
  key: "a.md",
  layer: "template",
  path: null,
  disabled: false,
  layers: { template: "content" },
  ...over,
});

describe("triage layer helpers", () => {
  it("maps the winning layer to Mine / Template / Built-in / Off", () => {
    expect(layerBadge(file({ layer: "user" }))).toBe("mine");
    expect(layerBadge(file({ layer: "template" }))).toBe("template");
    expect(layerBadge(file({ layer: "builtin" }))).toBe("builtin");
    expect(layerBadge(file({ layer: null, disabled: true }))).toBe("off");
  });

  it("explains where a file's text comes from", () => {
    expect(layerNote(file({ layer: "user", layers: { template: "content", user: "content" } }), "CFO")).toBe(
      "Your version replaces the template",
    );
    expect(layerNote(file({ layer: "user", layers: { user: "content" } }), "CFO")).toBe("Only yours: you added it");
    expect(layerNote(file({ layer: null, disabled: true, layers: { template: "disabled" } }), "CFO")).toBe(
      "Turned off in the CFO template",
    );
    expect(layerNote(file({ layer: null, disabled: true, layers: { template: "content", user: "disabled" } }), "CFO")).toBe(
      "Turned off for you",
    );
  });

  it("only treats a file as locked off when the template turned it off and I have nothing of my own", () => {
    expect(offByTemplate(file({ layer: null, disabled: true, layers: { template: "disabled" } }))).toBe(true);
    expect(offByTemplate(file({ layer: null, disabled: true, layers: { template: "content", user: "disabled" } }))).toBe(false);
  });

  it("validates a new file of mine", () => {
    expect(newFileKey("vip-senders", [])).toEqual({ key: "vip-senders.md" });
    expect(newFileKey("vip.md", ["vip.md"]).error).toMatch(/already exists/);
    expect(newFileKey("what-i-care-about.md", []).error).toMatch(/kept for/);
    expect(newFileKey("../x", []).error).toMatch(/letters, numbers/);
    expect(newFileKey("  ", []).error).toMatch(/name/);
  });

  it("binds every call to the profile and never carries a user id", () => {
    expect(triageUrl("/file", "CFO", { kind: "email", key: "a.md", layer: "user" })).toBe(
      "/api/triage/layers/file?kind=email&key=a.md&layer=user&profile=CFO",
    );
    expect(triageUrl("", "default", { kind: "email" })).toBe("/api/triage/layers?kind=email");
  });
});
