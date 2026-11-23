import type { PlaybookAncestor, PlaybookRev, PlaybookStep, ProjectPlaybookResponse } from "@/types";
import { planDiff, type PlanDiffKind } from "@/components/projects/changes/planDiff";

/**
 * Where a revision stands: the one runs use, a proposal (awaiting Make
 * active or Discard), or an earlier one that is history. Several proposals
 * can wait at once: a revision that was never active and either is newer
 * than the active one or records the revision it was written from stays a
 * proposal when another is made active. One that was active once is
 * history. With no active revision every revision is a proposal.
 */
export type RevisionState = "active" | "proposed" | "earlier";

export function revisionState(rev: PlaybookRev, activeRev: number | null | undefined): RevisionState {
  if (rev.active || rev.rev === activeRev) return "active";
  if (activeRev == null) return "proposed";
  if (rev.activated_at != null) return "earlier";
  if (rev.rev > activeRev || rev.base_rev != null) return "proposed";
  return "earlier";
}

export type ProposalBase = {
  /** The revision it was written from: null on old rows, 0 when written from none. */
  base: number | null;
  /**
   * The version it really builds on: up its chain of pending proposals to
   * one that is or was active; or the revision missing from that chain.
   */
  from: number | null;
  outdated: boolean;
  /** Its changes can be re-applied onto the active version. */
  canUpdate: boolean;
  why: "older" | "missing" | "root" | null;
};

/**
 * A proposal that doesn't build on the active version is "based on an
 * older version", including one written from a pending proposal whose own
 * base is no longer active: making it active would undo what changed in
 * between. It can be updated from the nearest version it shares with the
 * active one, else its nearest version that was active. Revisions are never
 * edited once saved, so the chain stays true; a discarded one on the way is
 * followed through `discarded`.
 */
export function proposalBase(
  rev: PlaybookRev,
  revisions: readonly PlaybookRev[],
  activeRev: number | null | undefined,
  discarded: readonly PlaybookAncestor[] = [],
): ProposalBase {
  const base = rev.base_rev ?? null;
  const settled: ProposalBase = { base, from: null, outdated: false, canUpdate: false, why: null };
  if (base == null || activeRev == null || revisionState(rev, activeRev) !== "proposed") return settled;
  const find = (n: number): PlaybookAncestor | undefined =>
    revisions.find((r) => r.rev === n) ?? discarded.find((r) => r.rev === n);
  const lineage = (start: number | null) => {
    const out: PlaybookAncestor[] = [];
    const seen = new Set<number>();
    let cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const at = find(cur);
      if (!at) return { out, missing: cur };
      out.push(at);
      cur = at.base_rev ?? null;
    }
    return { out, missing: null };
  };
  // The same decision the server makes on "Update onto active".
  const mine = lineage(base);
  if (mine.out.some((r) => r.rev === activeRev)) return { ...settled, from: activeRev };
  const onActive = new Set(lineage(activeRev).out.map((r) => r.rev));
  const shared =
    mine.out.find((r) => onActive.has(r.rev)) ??
    mine.out.find((r) => ("active" in r && r.active) || r.activated_at != null);
  if (shared) return { base, from: shared.rev, outdated: true, canUpdate: true, why: "older" };
  return { base, from: mine.missing, outdated: true, canUpdate: false, why: mine.missing != null ? "missing" : "root" };
}

/** Oldest first, the order the version chips read in. */
export function revisionsAscending(playbook: ProjectPlaybookResponse | null): PlaybookRev[] {
  return [...(playbook?.revisions ?? [])].sort((a, b) => a.rev - b.rev);
}

/**
 * The version the Playbook card opens on: the newest proposal (it is the
 * pending decision), else the active one, else the newest.
 */
export function defaultRevision(playbook: ProjectPlaybookResponse | null): number | null {
  const revs = revisionsAscending(playbook);
  if (revs.length === 0) return playbook?.active?.rev ?? null;
  const activeRev = playbook?.active?.rev;
  const proposed = revs.filter((r) => revisionState(r, activeRev) === "proposed");
  if (proposed.length > 0) return proposed[proposed.length - 1].rev;
  if (activeRev != null && revs.some((r) => r.rev === activeRev)) return activeRev;
  return revs[revs.length - 1].rev;
}

/**
 * What `to` is compared against by default: the active revision (what
 * making `to` active would change), or, when `to` is the active one, the
 * version just before it (what it changed), else the next one after it.
 */
export function defaultCompareBase(
  playbook: ProjectPlaybookResponse | null,
  to: number,
): number | null {
  const revs = revisionsAscending(playbook);
  const activeRev = playbook?.active?.rev;
  if (activeRev != null && activeRev !== to && revs.some((r) => r.rev === activeRev)) return activeRev;
  const older = revs.filter((r) => r.rev < to);
  if (older.length > 0) return older[older.length - 1].rev;
  const newer = revs.find((r) => r.rev > to);
  return newer ? newer.rev : null;
}

/** A step-level change between two versions of the same step. */
export type StepChange =
  | { kind: "title"; from: string }
  | { kind: "body" }
  | { kind: "checkpointOn" }
  | { kind: "checkpointOff" }
  | { kind: "after"; titles: string[] }
  | { kind: "startsFirst" }
  | { kind: "assignee"; to: string | null }
  | { kind: "mode"; to: string }
  | { kind: "toolsets" }
  /** Set by the caller: the step changed and also moved in the order. */
  | { kind: "position" };

function depsOf(step: PlaybookStep): string[] {
  return [...(step.depends_on ?? step.needs ?? [])].sort();
}

/**
 * What changed in one step, for the Compare list. Dependencies compare by
 * the titles they name on each side (`beforeTitleOf` / `afterTitleOf`), so
 * a re-keyed step that still waits on the same predecessor is no change.
 */
export function stepChanges(
  before: PlaybookStep,
  after: PlaybookStep,
  afterTitleOf: (key: string) => string = (key) => key,
  beforeTitleOf: (key: string) => string = afterTitleOf,
): StepChange[] {
  const out: StepChange[] = [];
  if (before.title.trim() !== after.title.trim()) out.push({ kind: "title", from: before.title.trim() });
  if ((before.body ?? "").trim() !== (after.body ?? "").trim()) out.push({ kind: "body" });
  if (!before.checkpoint && after.checkpoint) out.push({ kind: "checkpointOn" });
  if (before.checkpoint && !after.checkpoint) out.push({ kind: "checkpointOff" });
  const da = depsOf(before).map(beforeTitleOf).sort();
  const db = depsOf(after).map(afterTitleOf).sort();
  if (da.join("\n") !== db.join("\n")) {
    out.push(db.length ? { kind: "after", titles: db } : { kind: "startsFirst" });
  }
  if ((before.assignee ?? null) !== (after.assignee ?? null)) out.push({ kind: "assignee", to: after.assignee ?? null });
  if ((before.mode ?? "card") !== (after.mode ?? "card")) out.push({ kind: "mode", to: after.mode ?? "card" });
  if (toolsetsOf(before) !== toolsetsOf(after)) out.push({ kind: "toolsets" });
  return out;
}

function toolsetsOf(step: PlaybookStep): string {
  return step.toolsets ? [...step.toolsets].sort().join(",") : "";
}

export interface StepCompareRow {
  kind: PlanDiffKind;
  key: string;
  step: PlaybookStep;
  changes: StepChange[];
}

export interface StepCompare {
  rows: StepCompareRow[];
  added: number;
  changed: number;
  removed: number;
  moved: number;
  unchanged: boolean;
}

/**
 * Two versions' steps for Compare: `planDiff`'s matching, with each matched
 * step re-judged by `stepChanges` (which also sees assignee and toolsets,
 * and reads dependencies by title).
 */
export function compareSteps(from: readonly PlaybookStep[], to: readonly PlaybookStep[]): StepCompare {
  const beforeTitles = new Map(from.map((s) => [s.key, s.title]));
  const afterTitles = new Map(to.map((s) => [s.key, s.title]));
  const rows = planDiff(from, to).rows.map((row): StepCompareRow => {
    if (!row.before) return { kind: row.kind, key: row.key, step: row.step, changes: [] };
    const moved = row.kind === "moved" || Boolean(row.moved);
    const changes = stepChanges(
      row.before,
      row.step,
      (key) => afterTitles.get(key) ?? key,
      (key) => beforeTitles.get(key) ?? key,
    );
    if (changes.length === 0) return { kind: moved ? "moved" : "same", key: row.key, step: row.step, changes };
    if (moved) changes.push({ kind: "position" });
    return { kind: "changed", key: row.key, step: row.step, changes };
  });
  const count = (kind: PlanDiffKind) => rows.filter((r) => r.kind === kind).length;
  const out = { rows, added: count("added"), changed: count("changed"), removed: count("removed"), moved: count("moved") };
  return { ...out, unchanged: out.added + out.changed + out.removed + out.moved === 0 };
}
