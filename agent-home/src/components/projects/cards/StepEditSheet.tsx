"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import {
  assignmentForSave,
  assignmentOf,
  useAssignableProfiles,
} from "@/components/projects/plan/StepAssignment";
import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n";
import type { PlaybookRev } from "@/types";

import { dependents, stepDeps, stepsWithEdit, type StepEdit } from "./stepCards";

/**
 * Edit one step from its card. Saving writes the whole revision back with
 * only this step changed (every other field carried as-is), as a new
 * proposed revision based on the one shown — even while other proposals
 * wait. Nothing is activated; that stays a separate Make active.
 */
export function StepEditSheet({
  slug,
  rev,
  stepKey,
  profiles,
  hostProfile,
  lockedReason,
  nextRev,
  onClose,
  onSaved,
}: {
  slug: string;
  rev: PlaybookRev;
  stepKey: string;
  profiles: string[];
  hostProfile: string | null;
  /** Why the step can only be read; null when it can be changed. */
  lockedReason: string | null;
  nextRev: number;
  onClose: () => void;
  /** The new proposal's number, once saved. */
  onSaved?: (rev: number) => void;
}) {
  const t = useT("playbookCards");
  const steps = rev.steps ?? [];
  const index = steps.findIndex((s) => s.key === stepKey);
  const step = steps[index];
  const [edit, setEdit] = useState<StepEdit>(() => ({
    title: step?.title ?? "",
    body: step?.body ?? "",
    assignee: step?.assignee ?? "",
    dependsOn: step ? stepDeps(step) : [],
    checkpoint: Boolean(step?.checkpoint),
  }));
  const [error, setError] = useState<string | null>(null);
  const save = useProjectAction<{ rev?: number }>();
  const roster = useAssignableProfiles(slug, lockedReason == null);
  if (!step) return null;

  const locked = lockedReason != null;
  const after = dependents(steps, step.key);
  const others = steps.filter((s) => s.key !== step.key && !after.has(s.key));
  // The assignable roster when loaded, plus any project profile or current
  // pick it left out; the project's own profiles until then.
  const outside = new Set((roster ?? []).filter((p) => !p.in_project).map((p) => p.name));
  const assignees = (roster ?? []).map((p) => p.name);
  for (const name of [...profiles, ...(step.assignee ? [step.assignee] : [])]) {
    if (!assignees.includes(name)) assignees.push(name);
  }

  const submit = () => {
    if (!edit.title.trim()) {
      setError(t("edit.titleRequired"));
      return;
    }
    setError(null);
    const assignment = assignmentForSave(assignmentOf(step), step.assignee ?? "", edit.assignee);
    void save.run(`/api/projects/${encodeURIComponent(slug)}/playbook`, {
      body: {
        body: rev.body ?? "",
        steps: stepsWithEdit(steps, step.key, edit, assignment as Record<string, unknown>),
        base_rev: rev.rev,
      },
      onSuccess: (data) => {
        onClose();
        if (typeof data?.rev === "number") onSaved?.(data.rev);
      },
    });
  };

  const input =
    "min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-60";

  return (
    <Sheet
      title={t("edit.title", { n: index + 1 })}
      onClose={onClose}
      component="StepEditSheet"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 text-sm"
          >
            {locked ? t("edit.close") : t("edit.cancel")}
          </button>
          {locked ? null : (
            <ActionButton
              type="submit"
              form="step-edit-form"
              busy={save.busy}
              pendingLabel={t("edit.saving")}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {t("edit.save")}
            </ActionButton>
          )}
        </div>
      }
    >
      <form
        id="step-edit-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {locked ? (
          <p
            data-component="StepEditLocked"
            className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-[var(--color-warn-text)]"
          >
            {lockedReason}
          </p>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-[var(--color-muted)]">{t("edit.titleLabel")}</span>
          <input
            className={input}
            value={edit.title}
            disabled={locked}
            onChange={(e) => setEdit({ ...edit, title: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-[var(--color-muted)]">{t("edit.bodyLabel")}</span>
          <textarea
            className={input}
            rows={3}
            value={edit.body}
            disabled={locked}
            onChange={(e) => setEdit({ ...edit, body: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-[var(--color-muted)]">{t("edit.assigneeLabel")}</span>
          <select
            className={input}
            value={edit.assignee}
            disabled={locked}
            onChange={(e) => setEdit({ ...edit, assignee: e.target.value })}
          >
            <option value="">
              {hostProfile ? t("edit.hostDefault", { profile: hostProfile }) : t("edit.noHost")}
            </option>
            {assignees.map((name) => (
              <option key={name} value={name}>
                {outside.has(name) ? t("edit.notInProject", { profile: name }) : name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 text-xs text-[var(--color-muted)]">{t("edit.dependsLabel")}</legend>
          {steps.length <= 1 ? (
            <p className="text-sm text-[var(--color-muted)]">{t("edit.dependsNone")}</p>
          ) : null}
          {others.map((other) => (
            <label key={other.key} className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                className="h-5 w-5"
                disabled={locked}
                checked={edit.dependsOn.includes(other.key)}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    dependsOn: e.target.checked
                      ? [...edit.dependsOn, other.key]
                      : edit.dependsOn.filter((k) => k !== other.key),
                  })
                }
              />
              <span>{other.title}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5"
            disabled={locked}
            checked={edit.checkpoint}
            onChange={(e) => setEdit({ ...edit, checkpoint: e.target.checked })}
          />
          <span>{t("edit.checkpointLabel")}</span>
        </label>
        {locked ? null : (
          <p className="text-xs text-[var(--color-muted)]">{t("edit.hint", { next: nextRev, rev: rev.rev })}</p>
        )}
        {error ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
        <ActionError action={save} />
      </form>
    </Sheet>
  );
}
