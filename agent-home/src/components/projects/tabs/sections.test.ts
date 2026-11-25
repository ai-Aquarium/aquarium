import { describe, expect, it } from "vitest";

import { resolveTabParam, withoutViewParam } from "./sections";

describe("?tab= mapping", () => {
  it("keeps the new section names", () => {
    expect(resolveTabParam("planning")).toEqual({ section: "planning" });
    expect(resolveTabParam("execution")).toEqual({ section: "execution" });
    expect(resolveTabParam("log")).toEqual({ section: "log" });
    expect(resolveTabParam("chat")).toEqual({ section: "chat" });
  });

  it.each([
    ["dashboard", { section: "execution", part: "dashboard" }],
    ["overview", { section: "execution" }],
    ["scope", { section: "planning", part: "scope" }],
    ["inputs", { section: "planning", part: "inputs" }],
    ["plan", { section: "planning", part: "plan" }],
    ["outputs", { section: "planning", part: "outputs" }],
    ["files", { section: "planning", part: "outputs" }],
    ["setup", { section: "planning", part: "scope" }],
    ["board", { section: "execution", part: "board" }],
    ["iterations", { section: "execution", part: "iterations" }],
    ["runs", { section: "execution", part: "runs" }],
    ["work", { section: "execution" }],
    ["skills", { section: "planning", sheet: "skills" }],
    ["settings", { section: "planning", sheet: "settings" }],
  ])("maps the old tab %s", (tab, target) => {
    expect(resolveTabParam(tab)).toEqual(target);
  });

  it("opens Planning for anything unknown", () => {
    expect(resolveTabParam(undefined)).toEqual({ section: "planning" });
    expect(resolveTabParam("nope")).toEqual({ section: "planning" });
  });
});

describe("?view= redirect", () => {
  it("strips view and keeps the rest of the query", () => {
    expect(withoutViewParam("/projects/p12", { view: "task" })).toBe("/projects/p12");
    expect(withoutViewParam("/projects/p12", { view: "project", tab: "board" })).toBe("/projects/p12?tab=board");
    expect(withoutViewParam("/projects", { view: "project", schedule: "set" })).toBe("/projects?schedule=set");
  });

  it("does nothing without view", () => {
    expect(withoutViewParam("/projects", { schedule: "set" })).toBeNull();
  });
});
