"use client";

import { useT } from "@/i18n";
import type { PlaybookRev } from "@/types";
import type { PlanDiffKind } from "@/components/projects/changes/planDiff";
import { XIcon } from "@/components/ui/icons";
import { SwapIcon } from "@/components/projects/playbook/icons";
import { compareSteps, revisionState, type StepChange } from "@/components/projects/playbook/revisions";
import { textDiff, type TextDiffRow } from "@/components/projects/playbook/textDiff";

const TEXT_ROW: Record<TextDiffRow["kind"], string> = {
  same: "",
  removed: "rounded bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)] text-[var(--color-danger)] line-through",
  added: "rounded bg-[color-mix(in_srgb,var(--color-success)_16%,transparent)] text-[var(--color-success)]",
};

const STEP_TAG: Record<PlanDiffKind, string> = {
  same: "border-[var(--color-border)] text-[var(--color-muted)]",
  added: "border-[var(--color-success)] text-[var(--color-success)]",
  changed: "border-[var(--color-warn)] text-[var(--color-warn-text)]",
  removed: "border-[var(--color-danger)] text-[var(--color-danger)]",
  moved: "border-[var(--color-border)] text-[var(--color-text)]",
};

/**
 * Any two playbook versions side by side: the text paragraph by paragraph
 * (removed struck through in red on the left, added in green on the
 * right), then the steps matched across both (same / changed / added /
 * removed / moved, with what changed in a changed step).
 */
export function RevisionCompare({
  revisions,
  activeRev,
  from,
  to,
  onFrom,
  onTo,
  onSwap,
  onClose,
}: {
  revisions: PlaybookRev[];
  activeRev: number | null;
  from: PlaybookRev;
  to: PlaybookRev;
  onFrom: (rev: number) => void;
  onTo: (rev: number) => void;
  onSwap: () => void;
  onClose: () => void;
}) {
  const t = useT("playbook");
  const text = textDiff(from.body, to.body);
  const steps = compareSteps(from.steps ?? [], to.steps ?? []);
  const identical = text.unchanged && steps.unchanged;

  const optionLabel = (rev: PlaybookRev) => {
    const state = revisionState(rev, activeRev);
    return t(state === "active" ? "diff.optionActive" : state === "proposed" ? "diff.optionProposed" : "diff.option", {
      rev: rev.rev,
    });
  };
  const select = (label: string, value: number, other: number, onChange: (rev: number) => void) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm"
    >
      {revisions.map((rev) => (
        <option key={rev.rev} value={rev.rev} disabled={rev.rev === other}>
          {optionLabel(rev)}
        </option>
      ))}
    </select>
  );

  const describe = (change: StepChange): string => {
    switch (change.kind) {
      case "title":
        return t("diff.renamed", { title: change.from });
      case "body":
        return t("diff.body");
      case "checkpointOn":
        return t("diff.checkpointOn");
      case "checkpointOff":
        return t("diff.checkpointOff");
      case "after":
        return t("diff.after", { titles: change.titles.map((x) => `“${x}”`).join(", ") });
      case "startsFirst":
        return t("diff.startsFirst");
      case "assignee":
        return t("diff.assignee", { who: change.to ?? t("diff.anyProfile") });
      case "mode":
        return t("diff.mode", { mode: change.to });
      case "toolsets":
        return t("diff.toolsets");
      case "position":
        return t("diff.position");
    }
  };

  const textColumn = (rev: PlaybookRev, rows: TextDiffRow[]) => (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <h4 className="text-xs font-medium text-[var(--color-muted)]">{t("diff.textOf", { rev: rev.rev })}</h4>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{t("diff.noText")}</p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-1 text-sm">
          {rows.map((row, i) => (
            <p key={i} data-diff={row.kind} className={`whitespace-pre-wrap px-1 ${TEXT_ROW[row.kind]}`}>
              {row.kind !== "same" ? (
                <span className="sr-only">{t(row.kind === "added" ? "diff.added" : "diff.removed")}: </span>
              ) : null}
              {row.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section data-component="RevisionCompare" aria-label={t("diff.heading")} className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {select(t("diff.from"), from.rev, to.rev, onFrom)}
        <button
          type="button"
          aria-label={t("diff.swap")}
          title={t("diff.swap")}
          onClick={onSwap}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--color-border)]"
        >
          <SwapIcon />
        </button>
        {select(t("diff.to"), to.rev, from.rev, onTo)}
        <span data-component="RevisionCompareCounts" className="flex-1 text-xs text-[var(--color-muted)]">
          {identical
            ? t("diff.identical", { from: from.rev, to: to.rev })
            : [
                t("diff.counts", { added: steps.added, changed: steps.changed, removed: steps.removed }),
                steps.moved ? t("diff.moved", { count: steps.moved }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        <button
          type="button"
          aria-label={t("diff.close")}
          title={t("diff.close")}
          onClick={onClose}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-muted)]"
        >
          <XIcon />
        </button>
      </div>

      {text.unchanged && (from.body || to.body) ? (
        <p data-component="RevisionTextSame" className="text-sm text-[var(--color-muted)]">
          {t("diff.sameText")}
        </p>
      ) : (
        <div data-component="RevisionTextDiff" className="grid gap-2 md:grid-cols-2">
          {textColumn(from, text.before)}
          {textColumn(to, text.after)}
        </div>
      )}

      <div data-component="RevisionStepDiff">
        <h4 className="text-xs font-medium text-[var(--color-muted)]">{t("diff.steps")}</h4>
        {steps.rows.length === 0 ? (
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">{t("diff.noSteps")}</p>
        ) : (
          <ol className="mt-1.5 flex flex-col gap-1">
            {steps.rows.map((row) => {
              const { changes } = row;
              return (
                <li
                  key={`${row.kind}-${row.key}`}
                  data-step-diff={row.kind}
                  className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded-full border px-2 text-[11px] leading-5 ${STEP_TAG[row.kind]}`}
                  >
                    {t(row.kind === "moved" ? "diff.movedKind" : `diff.${row.kind}`)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={row.kind === "removed" ? "line-through text-[var(--color-muted)]" : undefined}>
                      {row.step.title}
                    </span>
                    {changes.length > 0 ? (
                      <span className="block text-xs text-[var(--color-muted)]">
                        {changes.map(describe).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
