import { describe, expect, it } from "vitest";

import { resolveTabParam, withoutViewParam } from "./sections";

describe("?tab= mapping", () => {
  it("keeps the new step names", () => {
    expect(resolveTabParam("requirements")).toEqual({ view: "requirements" });
    expect(resolveTabParam("plan")).toEqual({ view: "plan" });
    expect(resolveTabParam("cards")).toEqual({ view: "cards" });
    expect(resolveTabParam("runs")).toEqual({ view: "runs" });
    expect(resolveTabParam("chat")).toEqual({ view: "chat" });
  });

  it.each([
    ["dashboard", { view: "runs", part: "dashboard" }],
    ["overview", { view: "runs" }],
    ["scope", { view: "requirements", part: "scope" }],
    ["inputs", { view: "requirements", part: "inputs" }],
    ["plan", { view: "plan" }],
    ["outputs", { view: "runs", part: "outputs" }],
    ["files", { view: "runs", part: "outputs" }],
    ["setup", { view: "requirements", part: "scope" }],
    ["board", { view: "cards", part: "board" }],
    ["iterations", { view: "runs", part: "iterations" }],
    ["runs", { view: "runs" }],
    ["work", { view: "runs" }],
    ["planning", { view: "requirements" }],
    ["execution", { view: "runs" }],
    ["skills", { view: "requirements", sheet: "skills" }],
    ["settings", { view: "requirements", sheet: "settings" }],
    ["log", { view: "requirements", sheet: "log" }],
  ])("maps the old tab %s", (tab, target) => {
    expect(resolveTabParam(tab)).toEqual(target);
  });

  it("opens Requirements for anything unknown", () => {
    expect(resolveTabParam(undefined)).toEqual({ view: "requirements" });
    expect(resolveTabParam("nope")).toEqual({ view: "requirements" });
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
