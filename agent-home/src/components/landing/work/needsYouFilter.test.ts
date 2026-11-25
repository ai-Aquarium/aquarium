import { describe, expect, it } from "vitest";

import type { SuggestedTask } from "@/types";
import type { NeedsYouEntry, NeedsYouSource } from "@/types/landing";

import {
  EMPTY_FILTER,
  activeFilterCount,
  applyFilter,
  facetsOf,
  filterIsActive,
  sourceGroupOf,
  whoOf,
} from "./needsYouFilter";
import { needsYouEntry } from "./fixtures";

const entry = (over: Partial<NeedsYouEntry> = {}): NeedsYouEntry =>
  needsYouEntry(over);

const task = (id: string): SuggestedTask =>
  ({ todo: { id }, channel: "other", source: null }) as unknown as SuggestedTask;

describe("sourceGroupOf", () => {
  it("puts every project-sourced wait in projects", () => {
    const projectSources: NeedsYouSource[] = [
      "project_checkpoint",
      "budget",
      "card_wait",
      "card_approval",
      "card_blocked",
      "output_acceptance",
      "clarify",
      "plan_approval",
    ];
    for (const source of projectSources) {
      expect(sourceGroupOf(entry({ source, context: {} }))).toBe("projects");
    }
  });

  it("treats any entry carrying a project slug as a project wait", () => {
    // A notification-derived row has the slug even though its source is "notification".
    expect(
      sourceGroupOf(
        entry({ source: "notification", context: { project_slug: "x" } }),
      ),
    ).toBe("projects");
  });

  it("maps the non-project sources to their buckets", () => {
    const cases: [NeedsYouSource, string][] = [
      ["chat_tool_approval", "approvals"],
      ["webview_approval", "approvals"],
      ["source_claim", "approvals"],
      ["todo", "messages"],
      ["notification", "messages"],
      ["data_draft", "data"],
      ["data_schema", "data"],
      ["data_health", "data"],
      ["profile_suggestion", "other"],
      ["pin_suggestion", "other"],
    ];
    for (const [source, group] of cases) {
      expect(sourceGroupOf(entry({ source, context: {} }))).toBe(group);
    }
  });
});

describe("whoOf", () => {
  it("separates mine, team duties and other people's waits", () => {
    expect(whoOf(entry())).toBe("me");
    expect(whoOf(entry({ team: true }))).toBe("team");
    expect(whoOf(entry({ foreign: true, owner_user_id: "u-ada" }))).toBe("u-ada");
    expect(whoOf(entry({ foreign: true }))).toBe("someone");
    // Foreign wins over team: a team duty of someone else is still theirs.
    expect(whoOf(entry({ foreign: true, team: true, owner_user_id: "u-ada" }))).toBe("u-ada");
  });
});

describe("facetsOf", () => {
  it("counts each group and who bucket that is present, suggested tasks as me", () => {
    const items = [
      entry({ id: "p1", context: { project_slug: "a" } }),
      entry({ id: "p2", context: { project_slug: "b" }, team: true }),
      entry({ id: "m1", source: "todo", context: {} }),
      entry({ id: "theirs", source: "todo", context: {}, foreign: true, owner_user_id: "u-ada" }),
    ];
    const facets = facetsOf(items, [task("t1"), task("t2")]);
    expect(facets.groups).toEqual([
      { id: "suggested", count: 2 },
      { id: "projects", count: 2 },
      { id: "messages", count: 2 },
    ]);
    expect(facets.who).toEqual([
      { id: "me", count: 4 },
      { id: "team", count: 1 },
      { id: "u-ada", count: 1 },
    ]);
  });

  it("omits buckets with nothing in them", () => {
    const facets = facetsOf([], []);
    expect(facets.groups).toEqual([]);
    expect(facets.who).toEqual([]);
  });
});

describe("applyFilter", () => {
  const items = [
    entry({ id: "proj", context: { project_slug: "a" } }),
    entry({ id: "mine-todo", source: "todo", context: {} }),
    entry({ id: "team-data", source: "data_health", context: {}, team: true }),
    entry({ id: "theirs", source: "todo", context: {}, foreign: true, owner_user_id: "u-ada" }),
  ];
  const suggested = [task("s1")];
  const ids = (r: { entries: NeedsYouEntry[] }) => r.entries.map((e) => e.id);

  it("passes everything through with an empty filter", () => {
    const r = applyFilter(items, suggested, EMPTY_FILTER);
    expect(ids(r)).toEqual(["proj", "mine-todo", "team-data", "theirs"]);
    expect(r.suggested).toEqual(suggested);
    expect(filterIsActive(EMPTY_FILTER)).toBe(false);
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
  });

  it("filters by source group, suggested tasks included", () => {
    const r = applyFilter(items, suggested, { groups: ["projects"], who: [] });
    expect(ids(r)).toEqual(["proj"]);
    expect(r.suggested).toEqual([]);
    const s = applyFilter(items, suggested, { groups: ["suggested"], who: [] });
    expect(ids(s)).toEqual([]);
    expect(s.suggested).toEqual(suggested);
  });

  it("filters by who: team, another person, or several buckets at once", () => {
    expect(ids(applyFilter(items, suggested, { groups: [], who: ["team"] }))).toEqual(["team-data"]);
    expect(ids(applyFilter(items, suggested, { groups: [], who: ["u-ada"] }))).toEqual(["theirs"]);
    expect(ids(applyFilter(items, suggested, { groups: [], who: ["me", "team"] }))).toEqual([
      "proj",
      "mine-todo",
      "team-data",
    ]);
  });

  it("combines both dimensions and hides suggested tasks when me is off", () => {
    const r = applyFilter(items, suggested, { groups: ["projects", "suggested"], who: ["team"] });
    expect(ids(r)).toEqual([]);
    expect(r.suggested).toEqual([]);
    const r2 = applyFilter(items, suggested, { groups: ["projects"], who: ["me"] });
    expect(ids(r2)).toEqual(["proj"]);
    expect(r2.suggested).toEqual([]);
  });
});
