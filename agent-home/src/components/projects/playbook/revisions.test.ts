import { describe, expect, it } from "vitest";

import type { PlaybookRev, ProjectPlaybookResponse } from "@/types";
import {
  defaultCompareBase,
  defaultRevision,
  proposalBase,
  revisionState,
  revisionsAscending,
  compareSteps,
  stepChanges,
} from "@/components/projects/playbook/revisions";

const rev = (n: number, active = false): PlaybookRev => ({
  project_id: "prj_1",
  rev: n,
  body: `v${n}`,
  steps: [],
  active: active ? 1 : 0,
  created_by: "leo",
  created_at: n,
  activated_at: active ? n : null,
  note: null,
});

const book = (activeRev: number | null, revs: number[]): ProjectPlaybookResponse => ({
  active: activeRev == null ? null : rev(activeRev, true),
  revisions: revs.map((n) => rev(n, n === activeRev)).sort((a, b) => b.rev - a.rev),
});

describe("playbook revisions", () => {
  it("classifies against the active revision", () => {
    expect(revisionState(rev(4, true), 4)).toBe("active");
    expect(revisionState(rev(5), 4)).toBe("proposed");
    expect(revisionState(rev(3), 4)).toBe("earlier");
    expect(revisionState(rev(1), null)).toBe("proposed");
  });

  it("lists oldest first", () => {
    expect(revisionsAscending(book(2, [3, 1, 2])).map((r) => r.rev)).toEqual([1, 2, 3]);
  });

  it("opens on the newest proposal, else the active one", () => {
    expect(defaultRevision(book(4, [1, 2, 3, 4, 5]))).toBe(5);
    expect(defaultRevision(book(4, [1, 2, 3, 4]))).toBe(4);
    expect(defaultRevision(book(null, [1, 2]))).toBe(2);
    expect(defaultRevision(book(null, []))).toBeNull();
  });

  it("compares against the active revision, or the active one against its predecessor", () => {
    const pb = book(4, [1, 2, 3, 4, 5]);
    expect(defaultCompareBase(pb, 5)).toBe(4);
    expect(defaultCompareBase(pb, 2)).toBe(4);
    expect(defaultCompareBase(pb, 4)).toBe(3);
    expect(defaultCompareBase(book(1, [1, 2]), 1)).toBe(2);
    expect(defaultCompareBase(book(1, [1]), 1)).toBeNull();
    // The base is never the version being compared.
    for (const n of [1, 2, 3, 4, 5]) expect(defaultCompareBase(pb, n)).not.toBe(n);
  });

  it("names what changed in a step, and nothing for an identical one", () => {
    const before = { key: "clean", title: "Clean the rows", depends_on: ["pull"], assignee: "default" };
    expect(stepChanges(before, { ...before })).toEqual([]);
    expect(
      stepChanges(
        before,
        { ...before, title: "Clean + dedupe", checkpoint: true, depends_on: [], assignee: "finance" },
      ).map((c) => c.kind),
    ).toEqual(["title", "checkpointOn", "startsFirst", "assignee"]);
    expect(
      stepChanges({ ...before, depends_on: [] }, before, (k) => (k === "pull" ? "Pull the export" : k)),
    ).toEqual([{ kind: "after", titles: ["Pull the export"] }]);
  });

  it("Compare counts an assignee- or toolset-only change, not a re-keyed dependency", () => {
    const from = [
      { key: "pull", title: "Pull the export" },
      { key: "clean", title: "Clean the rows", depends_on: ["pull"], assignee: "default" },
    ];
    const reassigned = compareSteps(from, [from[0], { ...from[1], assignee: "finance", toolsets: ["web"] }]);
    expect(reassigned.unchanged).toBe(false);
    expect(reassigned.changed).toBe(1);
    expect(reassigned.rows[1].changes.map((c) => c.kind)).toEqual(["assignee", "toolsets"]);

    const rekeyed = compareSteps(from, [
      { key: "pull-the-export", title: "Pull the export" },
      { key: "clean", title: "Clean the rows", depends_on: ["pull-the-export"], assignee: "default" },
    ]);
    expect(rekeyed.unchanged).toBe(true);
    expect(rekeyed.rows.every((r) => r.kind === "same" && r.changes.length === 0)).toBe(true);
  });
});

describe("several proposals at once", () => {
  const r = (n: number, over: Partial<PlaybookRev> = {}): PlaybookRev => ({ ...rev(n), ...over });

  it("a never-active revision that records its base stays proposed when a newer one is made active", () => {
    expect(revisionState(r(6, { base_rev: 4 }), 7)).toBe("proposed");
    // Was active once: history, whatever its number.
    expect(revisionState(r(6, { base_rev: 4, activated_at: 10 }), 7)).toBe("earlier");
    // An old revision with no recorded base is history, as before.
    expect(revisionState(r(3), 7)).toBe("earlier");
    expect(revisionState(r(8), 7)).toBe("proposed");
  });

  it("is outdated when the version it really builds on, through pending proposals, isn't active", () => {
    const revs = [
      r(4, { activated_at: 1 }),
      r(5, { active: 1, activated_at: 2, base_rev: 4 }),
      r(6, { base_rev: 4 }),
      r(7, { base_rev: 6 }),
      r(8, { base_rev: 5 }),
      r(9, { base_rev: 8 }),
    ];
    const at = (n: number) => revs.find((x) => x.rev === n)!;
    expect(proposalBase(at(6), revs, 5)).toMatchObject({ base: 4, from: 4, outdated: true, canUpdate: true, why: "older" });
    // Written from the pending v6, whose own base v4 is no longer active.
    expect(proposalBase(at(7), revs, 5)).toMatchObject({ base: 6, from: 4, outdated: true, canUpdate: true });
    expect(proposalBase(at(8), revs, 5)).toMatchObject({ outdated: false, canUpdate: false });
    // Written from the pending v8, which builds on the active v5.
    expect(proposalBase(at(9), revs, 5)).toMatchObject({ base: 8, from: 5, outdated: false });
    // A revision on the way was discarded: outdated, nothing to re-apply from.
    expect(proposalBase(r(10, { base_rev: 2 }), revs, 5)).toMatchObject({ from: 2, outdated: true, canUpdate: false, why: "missing" });
    // Written from nothing before anything was active.
    expect(proposalBase(r(3, { base_rev: 0 }), revs, 5)).toMatchObject({ base: 0, outdated: true, canUpdate: false, why: "root" });
    expect(revisionState(r(3, { base_rev: 0 }), 5)).toBe("proposed");
    expect(proposalBase(at(5), revs, 5).outdated).toBe(false);
  });
});
