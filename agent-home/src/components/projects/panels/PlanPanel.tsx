"use client";

import { useCallback, useEffect, useState } from "react";
import { friendlyError } from "@/components/projects/errors";

import { BusyRegion } from "@/components/ui/BusyRegion";
import { useRefresh } from "@/components/ui/useRefresh";
import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import {
  AssignmentDetails,
  ProfileFacts,
  WhoDoesWhat,
  ASSIGNMENT_FIELDS,
  assignmentForSave,
  assignmentOf,
  hasAssignment,
  useAssignableProfiles,
} from "@/components/projects/plan/StepAssignment";
import type {
  AssignableProfile,
  PlaybookRev,
  PlaybookStep,
  ProjectPlaybookDraftState,
  ProjectPlaybookResponse,
  StepAssignment,
} from "@/types";
import { useT } from "@/i18n";
import { PlaybookCards, PlaybookViewSwitch } from "@/components/projects/cards/PlaybookCards";
import type { CardsView } from "@/components/projects/cards/stepCards";
import { PencilIcon, SparklesIcon } from "@/components/ui/icons";
import { CompareIcon, MakeActiveIcon, RebaseIcon } from "@/components/projects/playbook/icons";
import { RevisionCompare } from "@/components/projects/playbook/RevisionCompare";
import { RevisionPicker } from "@/components/projects/playbook/RevisionPicker";
import {
  defaultCompareBase,
  defaultRevision,
  proposalBase,
  revisionState,
  revisionsAscending,
  type RevisionState,
} from "@/components/projects/playbook/revisions";

/** How often the panel asks the server whether the agent's draft is ready. */
export const DRAFT_POLL_MS = 2_000;

interface StepDraft {
  title: string;
  assignee: string;
  after: string;
  checkpoint: boolean;
  /** The step's C-3 assignment fields as loaded, and the assignee they explain. */
  assignment: StepAssignment | null;
  origAssignee: string;
  /** The stored step this draft edits (and its `after` as loaded): what the
   * editor does not show — body, mode, toolsets, extra dependencies — is
   * saved back unchanged. */
  orig?: PlaybookStep;
  origAfter?: string;
}

const EMPTY_STEP: StepDraft = {
  title: "",
  assignee: "",
  after: "",
  checkpoint: false,
  assignment: null,
  origAssignee: "",
};

/** `Send the Monday digest` → `send-the-monday-digest`; unique within the list. */
export function stepKey(title: string, index: number, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `step-${index + 1}`;
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  taken.add(key);
  return key;
}

function stepsToPayload(drafts: StepDraft[]): PlaybookStep[] {
  const kept = drafts.filter((d) => d.title.trim());
  const taken = new Set<string>();
  const storedKey = new Map<StepDraft, string>();
  for (const d of kept) {
    if (d.orig?.key && !taken.has(d.orig.key)) {
      taken.add(d.orig.key);
      storedKey.set(d, d.orig.key);
    }
  }
  const keyed = kept.map((d, i) => ({ draft: d, key: storedKey.get(d) ?? stepKey(d.title.trim(), i, taken) }));
  const byTitle = new Map(keyed.map((k) => [k.draft.title.trim(), k.key]));
  const live = new Set(keyed.map((k) => k.key));
  return keyed.map(({ draft, key }) => {
    const { orig } = draft;
    const stored: Record<string, unknown> = { ...(orig ?? {}) };
    for (const field of ASSIGNMENT_FIELDS) delete stored[field];
    delete stored.needs;
    const depends_on =
      orig && draft.after === draft.origAfter
        ? (orig.depends_on ?? orig.needs ?? []).filter((k) => live.has(k))
        : draft.after && byTitle.has(draft.after)
          ? [byTitle.get(draft.after)!]
          : [];
    return {
      ...stored,
      key,
      title: draft.title.trim(),
      assignee: draft.assignee || null,
      depends_on,
      checkpoint: draft.checkpoint,
      ...assignmentForSave(draft.assignment, draft.origAssignee, draft.assignee),
    };
  });
}

/**
 * Inactive revisions split into pending proposals and history, as
 * `revisionState` reads them: a superseded (once active) revision is
 * history; several proposals can wait at once, and stay proposed when
 * another one is made active.
 */
export function splitRevisions(playbook: ProjectPlaybookResponse | null): {
  proposed: PlaybookRev[];
  earlier: PlaybookRev[];
} {
  const inactive = (playbook?.revisions ?? []).filter((rev) => !rev.active);
  const activeRev = playbook?.active?.rev;
  if (activeRev == null) return { proposed: inactive, earlier: [] };
  return {
    proposed: inactive.filter((rev) => revisionState(rev, activeRev) === "proposed"),
    earlier: inactive.filter((rev) => revisionState(rev, activeRev) === "earlier"),
  };
}

function draftsFromRev(rev: PlaybookRev | null): StepDraft[] {
  const steps = rev?.steps ?? [];
  if (steps.length === 0) return [{ ...EMPTY_STEP }];
  const titleByKey = new Map(steps.map((s) => [s.key, s.title]));
  return steps.map((s) => {
    const after = titleByKey.get((s.depends_on ?? s.needs ?? [])[0] ?? "") ?? "";
    return {
      title: s.title,
      assignee: s.assignee ?? "",
      after,
      checkpoint: Boolean(s.checkpoint),
      assignment: assignmentOf(s),
      origAssignee: s.assignee ?? "",
      orig: s,
      origAfter: after,
    };
  });
}

/** True when any step of these revisions says why it got its profile. */
function showsAssignments(revs: (PlaybookRev | null)[]): boolean {
  return revs.some((rev) => (rev?.steps ?? []).some((step) => hasAssignment(step)));
}

/**
 * The assignee picker's choices: the assignable roster when loaded (plus
 * any project profile or current pick it left out), else the project's
 * own profile names.
 */
function assigneeOptions(
  roster: AssignableProfile[] | null,
  profiles: string[],
  current: string,
): { name: string; label: string; title?: string }[] {
  const byName = new Map((roster ?? []).map((p) => [p.name, p]));
  const names = [...(roster ?? []).map((p) => p.name)];
  for (const name of [...profiles, ...(current ? [current] : [])]) {
    if (!names.includes(name)) names.push(name);
  }
  return names.map((name) => {
    const card = byName.get(name);
    if (!card) return { name, label: name };
    const tags = [card.is_host ? "host" : null, card.in_project ? null : "not in project yet"]
      .filter(Boolean)
      .join(", ");
    return {
      name,
      label: tags ? `${name} (${tags})` : name,
      title: card.description?.trim() || undefined,
    };
  });
}

/**
 * The project's playbook (Planning tab): a row of version chips, the
 * picked version's text and steps, and — for a proposed or earlier
 * version — the lead's Make active (or Discard). Compare puts any two
 * versions side by side (text diff + step diff). Saving is open to any
 * member and takes an optional version note; activation stays a human
 * lead/admin act (§7.2).
 *
 * "Draft with the agent" starts a server-side job (`POST …/playbook/draft`)
 * and polls until the proposal lands — nothing enters the user's chat, and
 * a reload while it runs resumes the wait.
 */
export function PlanPanel({
  slug,
  playbook,
  profiles,
  hostProfile = null,
  canActivate,
  archived,
  latestRunNo = null,
  canPropose = true,
}: {
  slug: string;
  playbook: ProjectPlaybookResponse | null;
  /** The project's profiles — the default step assignees. */
  profiles: string[];
  /** Where a step with no assignee runs. */
  hostProfile?: string | null;
  canActivate: boolean;
  archived: boolean;
  /** The newest run, whose card states the Kanban / Graph can show. */
  latestRunNo?: number | null;
  /** Member or lead: may propose a step change from its card. */
  canPropose?: boolean;
}) {
  const t = useT("playbook");
  const { refresh } = useRefresh();
  const active = playbook?.active ?? null;
  const activeRev = active?.rev ?? null;
  const { proposed } = splitRevisions(playbook);
  const listed = revisionsAscending(playbook);
  const revisions =
    active != null && !listed.some((r) => r.rev === active.rev)
      ? [...listed, active].sort((a, b) => a.rev - b.rev)
      : listed;

  /** The version chip the user picked; falls back when it is discarded. */
  const [picked, setPicked] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  /** The revision the editor was opened from; the server carries its step assignments. */
  const [baseRev, setBaseRev] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([{ ...EMPTY_STEP }]);
  const saveAction = useProjectAction<{ rev?: number }>();
  const busy = saveAction.busy;
  const draftAction = useProjectAction<ProjectPlaybookDraftState>();
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [activatedRev, setActivatedRev] = useState<number | null>(null);
  /** The proposal just saved here (editor or a card), for its confirmation. */
  const [savedRev, setSavedRev] = useState<number | null>(null);
  const [view, setView] = useState<CardsView>("text");
  const byRev = (rev: number | null) => (rev == null ? undefined : revisions.find((r) => r.rev === rev));
  const selected = byRev(picked) ?? byRev(defaultRevision(playbook)) ?? active;
  const compareBase =
    selected == null
      ? undefined
      : compareFrom != null && compareFrom !== selected.rev && byRev(compareFrom)
        ? byRev(compareFrom)
        : byRev(defaultCompareBase(playbook, selected.rev));
  const selectedState = selected ? revisionState(selected, activeRev) : null;

  const slugPath = `/api/projects/${encodeURIComponent(slug)}`;

  const roster = useAssignableProfiles(
    slug,
    playbook != null && (editing || showsAssignments([active, selected ?? null, ...proposed])),
  );
  const cardByName = new Map((roster ?? []).map((p) => [p.name, p]));

  const settleDraft = useCallback(
    (state: ProjectPlaybookDraftState) => {
      if (state.status === "running") {
        setDrafting(true);
        return;
      }
      setDrafting(false);
      if (state.status === "done") {
        setDraftNotice(
          `The agent proposed revision ${state.rev ?? ""} — review it below and activate it when it looks right.`,
        );
        if (typeof state.rev === "number") setPicked(state.rev);
        refresh();
      } else if (state.status === "failed") {
        setError(
          friendlyError(
            { status: 502, detail: state.detail },
            "The agent could not draft a plan — try again, or write it yourself.",
          ),
        );
      }
    },
    [refresh, setDrafting, setDraftNotice, setPicked, setError],
  );
  // On mount: resume waiting on a draft started before a reload. While
  // drafting: poll until the job settles. Both use the same GET.
  const unavailable = playbook == null;
  useEffect(() => {
    if (archived || unavailable) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch(`${slugPath}/playbook/draft`);
        const state = (await res.json().catch(() => ({}))) as ProjectPlaybookDraftState;
        if (cancelled) return;
        if (!res.ok || !state.status) {
          setDrafting(false);
          return;
        }
        if (state.status === "running") {
          setDrafting(true);
          timer = setTimeout(() => void poll(), DRAFT_POLL_MS);
          return;
        }
        // A finished job seen on first mount is old news; only report the
        // outcome of a draft this panel was waiting on.
        if (drafting) settleDraft(state);
      } catch {
        if (cancelled) return;
        setDrafting(false);
        if (drafting) setError("Could not reach the server.");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [archived, unavailable, slugPath, drafting, settleDraft]);

  const draftWithAgent = () => {
    setActivatedRev(null);
    setError(null);
    setDraftNotice(null);
    void draftAction.run(`${slugPath}/playbook/draft`, {
      body: {},
      skipRefresh: true,
      onSuccess: (data) => settleDraft(data),
    });
  };

  const openEditor = (from: PlaybookRev | null) => {
    setActivatedRev(null);
    setBody(from?.body ?? "");
    setNote("");
    setSteps(draftsFromRev(from));
    setBaseRev(from?.rev ?? null);
    setError(null);
    saveAction.clearError();
    setComparing(false);
    setEditing(true);
  };

  const save = () => {
    const payload = stepsToPayload(steps);
    if (payload.length === 0) {
      setError("A plan needs at least one step with a title.");
      return;
    }
    setError(null);
    void saveAction.run(`${slugPath}/playbook`, {
      body: {
        body: body.trim(),
        steps: payload,
        ...(baseRev != null ? { base_rev: baseRev } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      onSuccess: (data) => {
        setEditing(false);
        if (typeof data?.rev === "number") proposedHere(data.rev);
      },
    });
  };

  const selectRev = (rev: number) => {
    setPicked(rev);
    setActivatedRev(null);
  };

  const proposedHere = (rev: number) => {
    setPicked(rev);
    setActivatedRev(null);
    setSavedRev(rev);
  };

  /** Update onto active saves a new proposal; follow it there. */
  const [updated, setUpdated] = useState<ProposalUpdate | null>(null);
  const updatedHere = (update: ProposalUpdate) => {
    setPicked(update.rev);
    setActivatedRev(null);
    setUpdated(update);
  };

  const inputClass =
    "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";
  const toolClass =
    "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-xs disabled:opacity-50";

  return (
    <section
      id="panel-plan"
      data-component="PlanPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">
          {t("title")}
        </h2>
        {!editing && revisions.length > 0 ? <PlaybookViewSwitch view={view} onChange={setView} /> : null}
        {!editing && revisions.length > 0 && view === "text" ? (
          <button
            type="button"
            data-component="CompareRevisions"
            aria-pressed={comparing}
            onClick={() => setComparing((on) => !on)}
            disabled={revisions.length < 2}
            title={revisions.length < 2 ? t("compareOnlyOne") : undefined}
            className={`${toolClass} ${comparing ? "border-[var(--color-accent)] text-[var(--color-accent)]" : ""}`}
          >
            <CompareIcon size={14} />
            {t("compare")}
          </button>
        ) : null}
        {!archived && !editing && playbook != null ? (
          <ActionButton
            data-component="DraftPlanWithAgent"
            busy={draftAction.busy}
            pendingLabel="Starting the draft…"
            onClick={draftWithAgent}
            disabled={drafting}
            className={toolClass}
          >
            <SparklesIcon size={14} />
            {drafting ? "Agent is drafting…" : "Draft with the agent"}
          </ActionButton>
        ) : null}
        {!archived && !editing ? (
          <button
            type="button"
            data-component="EditPlaybook"
            onClick={() => openEditor(selected ?? active)}
            className={toolClass}
          >
            <PencilIcon size={14} />
            {active ? t("edit") : t("write")}
          </button>
        ) : null}
      </div>

      {playbook == null ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The plan is unavailable right now.
        </p>
      ) : (
        <>
          {active == null && !editing && !drafting && revisions.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              No active plan yet — a run needs one. Ask the agent to draft one
              from the brief, or write it here; either way you activate it
              when it looks right.
            </p>
          ) : null}

          {drafting ? (
            <p
              data-component="DraftPlanProgress"
              role="status"
              className="mt-2 text-sm text-[var(--color-muted)]"
            >
              The agent is reading the brief and drafting steps — usually under
              a minute. It will appear below as a proposed revision; you can
              leave this page, the draft continues on the server.
            </p>
          ) : null}

          {activatedRev != null && activeRev === activatedRev ? (
            <p
              data-component="PlanActivatedNotice"
              role="status"
              className="mt-2 text-sm text-[var(--color-accent)]"
            >
              {t("activatedNotice", { rev: activatedRev })}
            </p>
          ) : null}

          {draftNotice ? (
            <p role="status" className="mt-2 text-sm text-[var(--color-accent)]">
              {draftNotice}
            </p>
          ) : null}

          {selected != null && !editing ? (
            <RevisionPicker
              revisions={revisions}
              activeRev={activeRev}
              selected={selected}
              onSelect={selectRev}
            />
          ) : null}

          {selected != null &&
          !editing &&
          selectedState !== "active" &&
          (view === "text" || selectedState === "proposed") ? (
            <RevisionDecision
              key={selected.rev}
              slug={slug}
              rev={selected}
              revisions={revisions}
              activeRev={activeRev}
              state={selectedState ?? "proposed"}
              canActivate={canActivate}
              canPropose={canPropose}
              archived={archived}
              justSaved={savedRev === selected.rev}
              updated={updated}
              onActivated={setActivatedRev}
              onUpdated={updatedHere}
            />
          ) : null}

          {view !== "text" && !editing && playbook != null && revisions.length > 0 ? (
            <PlaybookCards
              slug={slug}
              playbook={playbook}
              view={view}
              rev={selected}
              latestRunNo={latestRunNo}
              profiles={profiles}
              hostProfile={hostProfile}
              archived={archived}
              canPropose={canPropose}
              onProposed={proposedHere}
            />
          ) : null}

          {selected != null && !editing && view === "text" && comparing && compareBase ? (
            <RevisionCompare
              revisions={revisions}
              activeRev={activeRev}
              from={compareBase}
              to={selected}
              onFrom={setCompareFrom}
              onTo={(rev) => selectRev(rev)}
              onSwap={() => {
                setCompareFrom(selected.rev);
                selectRev(compareBase.rev);
              }}
              onClose={() => setComparing(false)}
            />
          ) : null}

          {selected != null && !editing && view === "text" && !(comparing && compareBase) ? (
            <RevisionBody
              rev={selected}
              state={selectedState ?? "active"}
              hostProfile={hostProfile}
              cardByName={cardByName}
            />
          ) : null}

          {editing ? (
            <BusyRegion busy={busy} label="Saving the plan…">
              <form
                data-component="PlanEditor"
                className="mt-3 flex flex-col gap-3 rounded-xl border border-dashed border-[var(--color-border)] p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-[var(--color-muted)]">
                    How the agent should approach it (optional)
                  </span>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={3}
                    placeholder="Gather this week's arrivals, draft the digest, send it after a checkpoint…"
                    className={inputClass}
                  />
                </label>

                <div className="flex flex-col gap-2">
                  <span className="text-xs text-[var(--color-muted)]">
                    Steps — in order; each becomes a card on the board
                  </span>
                  {steps.map((step, index) => (
                    <div
                      key={index}
                      data-component="PlanStepRow"
                      className="flex flex-col gap-1.5 rounded-lg bg-[var(--color-surface-2)] p-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--color-muted)]">
                          {index + 1}.
                        </span>
                        <input
                          value={step.title}
                          onChange={(e) =>
                            setSteps((prev) =>
                              prev.map((s, i) =>
                                i === index ? { ...s, title: e.target.value } : s,
                              ),
                            )
                          }
                          placeholder="What this step delivers"
                          aria-label={`Step ${index + 1} title`}
                          className={inputClass}
                        />
                        {steps.length > 1 ? (
                          <button
                            type="button"
                            aria-label={`Remove step ${index + 1}`}
                            onClick={() =>
                              setSteps((prev) => prev.filter((_s, i) => i !== index))
                            }
                            className="rounded-lg border border-[var(--color-border)] px-2 text-sm text-[var(--color-muted)]"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 pl-5 text-xs">
                        <select
                          value={step.assignee}
                          onChange={(e) =>
                            setSteps((prev) =>
                              prev.map((s, i) =>
                                i === index ? { ...s, assignee: e.target.value } : s,
                              ),
                            )
                          }
                          aria-label={`Step ${index + 1} assignee`}
                          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
                        >
                          <option value="">any profile</option>
                          {assigneeOptions(roster, profiles, step.assignee).map((o) => (
                            <option key={o.name} value={o.name} title={o.title}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {index > 0 ? (
                          <select
                            value={step.after}
                            onChange={(e) =>
                              setSteps((prev) =>
                                prev.map((s, i) =>
                                  i === index ? { ...s, after: e.target.value } : s,
                                ),
                              )
                            }
                            aria-label={`Step ${index + 1} waits for`}
                            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
                          >
                            <option value="">can start right away</option>
                            {steps
                              .slice(0, index)
                              .filter((s) => s.title.trim())
                              .map((s) => (
                                <option key={s.title} value={s.title.trim()}>
                                  after “{s.title.trim()}”
                                </option>
                              ))}
                          </select>
                        ) : null}
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={step.checkpoint}
                            onChange={(e) =>
                              setSteps((prev) =>
                                prev.map((s, i) =>
                                  i === index
                                    ? { ...s, checkpoint: e.target.checked }
                                    : s,
                                ),
                              )
                            }
                          />
                          pause for my approval after
                        </label>
                        {step.assignee !== step.origAssignee && (step.origAssignee || step.assignment?.assigned_by) ? (
                          <span data-component="ChangedByYou" className="text-[var(--color-muted)]">
                            changed by you
                          </span>
                        ) : null}
                        {step.assignee && cardByName.get(step.assignee) ? (
                          <ProfileFacts profile={cardByName.get(step.assignee)!} />
                        ) : null}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSteps((prev) => [...prev, { ...EMPTY_STEP }])}
                    className="self-start rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs"
                  >
                    Add a step
                  </button>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-[var(--color-muted)]">{t("noteLabel")}</span>
                  <input
                    data-component="VersionNote"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                    placeholder={t("notePlaceholder")}
                    className={inputClass}
                  />
                </label>

                <p className="text-xs text-[var(--color-muted)]">
                  Saving proposes a new revision; nothing changes until a lead
                  activates it.
                </p>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={busy}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <ActionButton
                    type="submit"
                    busy={busy}
                    pendingLabel="Saving…"
                    className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                  >
                    Save as revision
                  </ActionButton>
                </div>
              </form>
            </BusyRegion>
          ) : null}

          {error ? (
            <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
          <ActionError action={saveAction} />
          <ActionError action={draftAction} />
        </>
      )}
    </section>
  );
}


/**
 * One version's text and steps, as runs read them: prose, who does what,
 * then the steps as an indented list (a dependent step sits one level in).
 */
function RevisionBody({
  rev,
  state,
  hostProfile = null,
  cardByName,
}: {
  rev: PlaybookRev;
  state: RevisionState;
  hostProfile?: string | null;
  cardByName: Map<string, AssignableProfile>;
}) {
  const steps = rev.steps ?? [];
  return (
    <div data-component="PlaybookRevision" data-rev={rev.rev} data-state={state}>
      {rev.body ? <p className="mt-2 whitespace-pre-wrap text-sm">{rev.body}</p> : null}
      {steps.length > 0 ? <WhoDoesWhat steps={steps} hostProfile={hostProfile} /> : null}
      {steps.length > 0 ? (
        <ol className="mt-2 flex flex-col gap-1">
          {steps.map((step, index) => (
            <li
              key={step.key}
              className="flex items-baseline gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
              style={{
                marginLeft: `${((step.depends_on ?? step.needs)?.length ?? 0) > 0 ? 1 : 0}rem`,
              }}
            >
              <span className="text-xs text-[var(--color-muted)]">{index + 1}.</span>
              <span className="min-w-0 flex-1">
                {step.title}
                {step.checkpoint ? (
                  <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-[var(--color-warn-text)]">
                    checkpoint
                  </span>
                ) : null}
                {step.assignee && !hasAssignment(step) ? (
                  <span className="ml-2 text-xs text-[var(--color-muted)]">→ {step.assignee}</span>
                ) : null}
                <AssignmentDetails
                  assignment={step}
                  assignee={step.assignee}
                  hostProfile={hostProfile}
                  profile={cardByName.get(step.assignee || hostProfile || "")}
                />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-[var(--color-muted)]">no steps</p>
      )}
    </div>
  );
}

/**
 * The decision bar under the version picker for a version that is not in
 * use: what making it active means, then the lead's Make active (the
 * primary action — nothing is ever activated by saving), Update onto
 * active for a proposal based on an older version, and Discard. Members
 * see who decides. A version saved without a note can be given one here —
 * it rides on the activate call.
 */
function RevisionDecision({
  slug,
  rev,
  revisions,
  activeRev,
  state,
  canActivate,
  canPropose,
  archived,
  justSaved,
  updated,
  onActivated,
  onUpdated,
}: {
  slug: string;
  rev: PlaybookRev;
  revisions: PlaybookRev[];
  activeRev: number | null;
  state: RevisionState;
  canActivate: boolean;
  canPropose: boolean;
  archived: boolean;
  /** Saved from this panel a moment ago: confirm it, then offer Make active. */
  justSaved: boolean;
  /** The proposal this one was just updated from (its notice shows here). */
  updated: ProposalUpdate | null;
  onActivated: (rev: number) => void;
  onUpdated: (update: ProposalUpdate) => void;
}) {
  const t = useT("playbook");
  const [note, setNote] = useState("");
  const addsNote = !archived && canActivate && !rev.note?.trim();
  const { base, from, outdated, canUpdate, why } = proposalBase(rev, revisions, activeRev);
  return (
    <div
      data-component="RevisionDecision"
      data-state={state}
      data-outdated={outdated ? "true" : undefined}
      className={`mt-3 flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-sm ${
        state === "proposed"
          ? "border-dashed border-[var(--color-warn)] bg-[var(--color-attention-bg)]"
          : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
      }`}
    >
      <p role={justSaved ? "status" : undefined} data-component={justSaved ? "ProposalSaved" : undefined}>
        {justSaved && base
          ? t("savedBanner", { rev: rev.rev, base })
          : t(state === "proposed" ? "proposedBanner" : "earlierBanner", { rev: rev.rev })}
      </p>
      {outdated && activeRev != null ? (
        <p data-component="ProposalOutdated" className="text-[var(--color-warn-text)]">
          {why === "root"
            ? t("outdatedRoot", { active: activeRev })
            : t(why === "older" ? "outdated" : "outdatedNoBase", { base: from ?? base ?? 0, active: activeRev })}
        </p>
      ) : null}
      {updated?.rev === rev.rev ? (
        <p role="status" data-component="ProposalUpdated" className="text-xs">
          {updated.conflicts.length > 0
            ? t("updatedConflicts", {
                rev: rev.rev,
                from: updated.from,
                active: updated.active,
                what: updated.conflicts.map((key) => (key === "body" ? t("conflictText") : key)).join(", "),
              })
            : t("updatedNotice", { rev: rev.rev, from: updated.from, active: updated.active })}
          {` ${t("updatedKept", { from: updated.from })}`}
        </p>
      ) : null}
      {addsNote ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-muted)]">{t("noteLabel")}</span>
          <input
            data-component="ActivationNote"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder={t("notePlaceholder")}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!archived && canActivate ? (
          <ActivateRevision slug={slug} rev={rev.rev} note={note} onActivated={onActivated} />
        ) : null}
        {!archived && canPropose && canUpdate && activeRev != null ? (
          <UpdateOntoActive slug={slug} rev={rev.rev} activeRev={activeRev} onUpdated={onUpdated} />
        ) : null}
        {!archived && canActivate ? <DiscardRevision slug={slug} rev={rev.rev} /> : null}
        {!archived && !canActivate ? (
          <span className="text-xs text-[var(--color-muted)]">{t("leadDecides")}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Re-apply a proposal's own changes onto the active version (it stays a
 * proposal). When both changed the same step, the proposal's version is
 * kept and named, so nothing is dropped silently.
 */
type ProposalUpdate = { rev: number; from: number; active: number; conflicts: string[] };

function UpdateOntoActive({
  slug,
  rev,
  activeRev,
  onUpdated,
}: {
  slug: string;
  rev: number;
  activeRev: number;
  onUpdated: (update: ProposalUpdate) => void;
}) {
  const t = useT("playbook");
  const action = useProjectAction<{ rev?: number; base_rev?: number; conflicts?: string[] }>();
  return (
    <>
      <ActionButton
        data-action="rebase-revision"
        busy={action.busy}
        pendingLabel={t("updating")}
        onClick={() =>
          void action.run(`/api/projects/${encodeURIComponent(slug)}/playbook/${rev}/rebase`, {
            body: {},
            onSuccess: (data) => {
              if (typeof data?.rev !== "number") return;
              onUpdated({
                rev: data.rev,
                from: rev,
                active: data.base_rev ?? activeRev,
                conflicts: data.conflicts ?? [],
              });
            },
          })
        }
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent)] disabled:opacity-50"
      >
        <RebaseIcon size={16} />
        {t("updateOntoActive")}
      </ActionButton>
      <ActionError
        action={action}
        className="flex w-full flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]"
      />
    </>
  );
}

/**
 * A lead's Discard on one inactive revision — "this draft is wrong",
 * the paired decision to Make active. Refused server-side when the rev is
 * active or a run pinned it (then the error surfaces inline).
 */
function DiscardRevision({ slug, rev }: { slug: string; rev: number }) {
  const t = useT("playbook");
  const action = useProjectAction();
  return (
    <>
      <ActionButton
        data-action="discard-revision"
        busy={action.busy}
        pendingLabel={t("discarding")}
        onClick={() =>
          void action.run(
            `/api/projects/${encodeURIComponent(slug)}/playbook/${rev}`,
            { method: "DELETE" },
          )
        }
        className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-3 text-sm disabled:opacity-50"
      >
        {t("discard")}
      </ActionButton>
      <ActionError
        action={action}
        className="flex w-full flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]"
      />
    </>
  );
}

/**
 * A lead's Make active on one revision — its own lock, so activating
 * never leaves another control looking idle mid-write.
 */
function ActivateRevision({
  slug,
  rev,
  note,
  onActivated,
}: {
  slug: string;
  rev: number;
  note: string;
  onActivated: (rev: number) => void;
}) {
  const t = useT("playbook");
  const action = useProjectAction();
  return (
    <>
      <ActionButton
        data-action="activate-revision"
        busy={action.busy}
        pendingLabel={t("activating")}
        onClick={() =>
          void action.run(
            `/api/projects/${encodeURIComponent(slug)}/playbook/${rev}/activate`,
            { body: note.trim() ? { note: note.trim() } : {}, onSuccess: () => onActivated(rev) },
          )
        }
        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--color-accent)] px-5 text-sm font-semibold text-[var(--color-accent-fg)] shadow-sm disabled:opacity-50"
      >
        <MakeActiveIcon size={18} />
        {t("makeActive")}
      </ActionButton>
      <ActionError
        action={action}
        className="flex w-full flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]"
      />
    </>
  );
}
