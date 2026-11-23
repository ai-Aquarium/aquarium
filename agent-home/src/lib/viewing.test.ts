// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { clearViewing, readViewing, setViewing, withOwners } from "@/lib/viewing";
import { ownersParam } from "@/lib/whose-data";

describe("Viewing (whose data, default = me)", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("opens on just me and sends no owners=", () => {
    expect(readViewing()).toEqual([]);
    expect(withOwners("/api/needs-you", readViewing())).toBe("/api/needs-you");
  });

  it("keeps the caller in a wider view and drops back to just me", () => {
    setViewing(["leo"], "sam");
    expect(readViewing()).toEqual(["sam", "leo"]);
    expect(withOwners("/api/todos?limit=5", readViewing())).toBe("/api/todos?limit=5&owners=sam%2Cleo");
    setViewing(["sam"], "sam");
    expect(readViewing()).toEqual([]);
    setViewing(["sam", "leo"], "sam");
    clearViewing();
    expect(readViewing()).toEqual([]);
  });

  it("forwards only a well-formed owners= upstream", () => {
    expect(ownersParam(new URLSearchParams("owners=sam,leo"))).toBe("sam,leo");
    expect(ownersParam(new URLSearchParams("owners=sam%26x%3D1"))).toBeUndefined();
    expect(ownersParam(new URLSearchParams(""))).toBeUndefined();
  });
});
