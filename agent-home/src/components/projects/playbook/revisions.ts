import type { PlaybookRev, PlaybookStep, ProjectPlaybookResponse } from "@/types";

/**
 * Where a revision stands: the one runs use, a proposal written after it
 * (awaiting Make active or Discard), or an earlier one that is history.
 * With no active revision every revision is a proposal.
 */
export type RevisionState = "active" | "proposed" | "earlier";

export function revisionState(rev: PlaybookRev, activeRev: number | null | undefined): RevisionState {
  if (rev.active || rev.rev === activeRev) return "active";
  if (activeRev == null || rev.rev > activeRev) return "proposed";
  return "earlier";
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
  /** Set by the caller: the step changed and also moved in the order. */
  | { kind: "position" };

function depsOf(step: PlaybookStep): string[] {
  return [...(step.depends_on ?? step.needs ?? [])].sort();
}

/**
 * What changed in one step, for the Compare list. `titleOf` names a
 * dependency by its title in the newer version (falling back to its key).
 */
export function stepChanges(
  before: PlaybookStep,
  after: PlaybookStep,
  titleOf: (key: string) => string = (key) => key,
): StepChange[] {
  const out: StepChange[] = [];
  if (before.title.trim() !== after.title.trim()) out.push({ kind: "title", from: before.title.trim() });
  if ((before.body ?? "").trim() !== (after.body ?? "").trim()) out.push({ kind: "body" });
  if (!before.checkpoint && after.checkpoint) out.push({ kind: "checkpointOn" });
  if (before.checkpoint && !after.checkpoint) out.push({ kind: "checkpointOff" });
  const da = depsOf(before);
  const db = depsOf(after);
  if (da.join(",") !== db.join(",")) {
    out.push(db.length ? { kind: "after", titles: db.map(titleOf) } : { kind: "startsFirst" });
  }
  if ((before.assignee ?? null) !== (after.assignee ?? null)) out.push({ kind: "assignee", to: after.assignee ?? null });
  if ((before.mode ?? "card") !== (after.mode ?? "card")) out.push({ kind: "mode", to: after.mode ?? "card" });
  return out;
}
