import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import en from "@/i18n/messages/en/projects.json";
import zh from "@/i18n/messages/zh-Hant/projects.json";
import type { ProjectDetail, ProjectLogEntry } from "@/types";

import { LOG_FILTERS, LOG_KINDS, ProjectLog, logHref, logParams, logQuery } from "./ProjectLog";

const entry = (over: Partial<ProjectLogEntry>): ProjectLogEntry => ({
  id: "run:3:start",
  actor: "person",
  who: "leo",
  kind: "runs",
  action: "run_started",
  detail: { run_no: 3 },
  at: 1_700_000_000,
  link: null,
  ...over,
});

describe("ProjectLog", () => {
  it("links a row to its run page or its card page, and nowhere otherwise", () => {
    expect(logHref("my digest", entry({ link: { type: "run", run_no: 3 } }))).toBe(
      "/projects/my%20digest/runs/3",
    );
    expect(logHref("d", entry({ link: { type: "card", id: "t/1" } }))).toBe("/projects/d/cards/t%2F1");
    expect(logHref("d", entry({ link: null }))).toBeNull();
  });

  it("joins list details and drops missing ones for the sentence", () => {
    expect(logParams(entry({ detail: { fields: ["goal", "description"], rev: null } }))).toEqual({
      fields: "goal, description",
    });
  });

  it("asks for a page with the chosen who, what and cursor", () => {
    const q = new URLSearchParams(logQuery("agents", "tools", "10:tool:x"));
    expect(q.get("actor")).toBe("agents");
    expect(q.get("kind")).toBe("tools");
    expect(q.get("cursor")).toBe("10:tool:x");
    expect(new URLSearchParams(logQuery("all", null, null)).has("kind")).toBe(false);
  });

  it("renders every who and what filter", () => {
    const html = renderToStaticMarkup(<ProjectLog project={{ slug: "d" } as ProjectDetail} />);
    for (const f of LOG_FILTERS) expect(html).toContain(`data-filter="${f}"`);
    for (const k of LOG_KINDS) expect(html).toContain(`data-kind="${k}"`);
  });

  it("has an en and a zh-Hant sentence for every action, with the same placeholders", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const enActions = en.log.action as Record<string, string>;
    const zhActions = zh.log.action as Record<string, string>;
    expect(Object.keys(zhActions).sort()).toEqual(Object.keys(enActions).sort());
    for (const [key, text] of Object.entries(enActions)) {
      expect(placeholders(zhActions[key])).toEqual(placeholders(text));
    }
    for (const k of LOG_KINDS) {
      expect(en.log.kinds[k]).toBeTruthy();
      expect(zh.log.kinds[k]).toBeTruthy();
    }
  });
});
