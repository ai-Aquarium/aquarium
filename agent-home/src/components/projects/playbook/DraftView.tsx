"use client";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { useT } from "@/i18n";
import type { PlaybookDraft, PlaybookRev } from "@/types";

import { AskAboutButton } from "./AskAbout";
import { draftChanges, draftOwner } from "./draftDiff";

/** `Draft · Leo (from v5)`: a draft has no number until it is saved. */
export function useDraftLabel(): (draft: PlaybookDraft) => string {
  const t = useT("playbook");
  return (draft) =>
    t("draft.label", {
      who: draftOwner(draft),
      from: draft.base_rev > 0 ? t("draft.from", { rev: draft.base_rev }) : t("draft.fromScratch"),
    });
}

/**
 * One member's working draft, highlighted against the revision it started
 * from. Its owner can Save as vN (a proposed revision, never active) or
 * discard it; a lead may discard anyone's. Everyone else reads it.
 */
export function DraftView({
  slug,
  draft,
  base,
  nextRev,
  onAsk,
  onSaved,
  onDiscarded,
}: {
  slug: string;
  draft: PlaybookDraft;
  /** The revision it started from, when that is still listed. */
  base: PlaybookRev | null;
  /** The number Save will most likely take (the server assigns it). */
  nextRev: number;
  onAsk?: (quote: string) => void;
  onSaved: (rev: number) => void;
  onDiscarded: () => void;
}) {
  const t = useT("playbook");
  const timeLabel = useTimeLabel();
  const label = useDraftLabel()(draft);
  const save = useProjectAction<{ rev?: number }>();
  const discard = useProjectAction();
  const changes = draftChanges(base, draft);
  const baseName = draft.base_rev > 0 ? t("draft.base", { rev: draft.base_rev }) : t("draft.baseNone");
  const busy = save.busy || discard.busy;
  const path = `/api/projects/${encodeURIComponent(slug)}/playbook/drafts`;

  return (
    <div data-component="PlaybookDraft" data-owner={draft.user_id} data-mine={draft.mine ? "true" : undefined}>
      <div className="mt-3 rounded-xl border border-dashed border-[var(--color-warn)] bg-[var(--color-attention-bg)] p-3 text-sm">
        <p>
          <b>{label}</b> ·{" "}
          {draft.mine && draft.can_edit
            ? t("draft.bannerMine", { base: baseName })
            : t("draft.bannerOther", { who: draftOwner(draft), base: baseName })}
        </p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {changes.count > 0
            ? t("draft.changes", { count: changes.count, base: baseName })
            : t("draft.noChanges", { base: baseName })}
          {" · "}
          {t("draft.edited", {
            who: draft.updated_by === "agent" ? t("draft.agent") : draft.updated_by && draft.updated_by !== draft.user_id ? draft.updated_by : draftOwner(draft),
            when: timeLabel(draft.updated_at),
          })}
        </p>
        {draft.can_edit || draft.can_discard ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {draft.can_edit ? (
              <ActionButton
                data-action="save-draft"
                busy={save.busy}
                disabled={busy || draft.steps.length === 0}
                pendingLabel={t("draft.saving")}
                onClick={() =>
                  void save.run(`${path}/me/save`, {
                    body: { expected_version: draft.version },
                    onSuccess: (data) => {
                      if (typeof data?.rev === "number") onSaved(data.rev);
                    },
                  })
                }
                className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                {t("draft.save", { rev: nextRev })}
              </ActionButton>
            ) : null}
            {draft.can_discard ? (
              <ActionButton
                data-action="discard-draft"
                busy={discard.busy}
                disabled={busy}
                pendingLabel={t("draft.discarding")}
                onClick={() =>
                  void discard.run(
                    `${path}/${draft.mine ? "me" : encodeURIComponent(draft.user_id)}?expected_version=${draft.version}`,
                    {
                      method: "DELETE",
                      onSuccess: onDiscarded,
                    },
                  )
                }
                className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-3 text-sm disabled:opacity-50"
              >
                {t("draft.discard")}
              </ActionButton>
            ) : null}
            {draft.can_edit ? (
              <span className="text-xs text-[var(--color-muted)]">{t("draft.saveHint")}</span>
            ) : null}
          </div>
        ) : null}
        <ActionError action={save} className="mt-1 text-xs text-[var(--color-danger)]" />
        <ActionError action={discard} className="mt-1 text-xs text-[var(--color-danger)]" />
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <section>
          <h3 className="text-xs font-semibold text-[var(--color-muted)]">{t("draft.text")}</h3>
          <div className="mt-1.5 flex flex-col gap-1 rounded-lg bg-[var(--color-surface-2)] p-2 text-sm">
            {changes.paragraphs.map((p, i) => (
              <div
                key={`${i}:${p.text}`}
                data-paragraph={i}
                data-changed={p.changed ? "true" : undefined}
                className={`flex items-start gap-1 rounded-md px-1.5 py-1 ${
                  p.changed ? "border border-[var(--color-warn)] bg-[var(--color-attention-bg)]" : ""
                }`}
              >
                <p className="min-w-0 flex-1 whitespace-pre-wrap">{p.text}</p>
                {onAsk ? <AskAboutButton where={`${label} · ¶${i + 1}`} text={p.text} onAsk={onAsk} /> : null}
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3 className="text-xs font-semibold text-[var(--color-muted)]">
            {t("draft.steps", { count: draft.steps.length })}
          </h3>
          {draft.steps.length === 0 ? (
            <p className="mt-1.5 text-sm text-[var(--color-muted)]">{t("draft.noSteps")}</p>
          ) : (
            <ol className="mt-1.5 flex flex-col gap-1.5">
              {draft.steps.map((step, index) => {
                const change = changes.steps.get(step.key);
                return (
                  <li
                    key={step.key}
                    data-step={step.key}
                    data-change={change}
                    className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                      change
                        ? "border-[var(--color-warn)] bg-[var(--color-attention-bg)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)]"
                    }`}
                  >
                    <span className="text-xs text-[var(--color-muted)]">{index + 1}.</span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-1.5 font-medium">
                        {step.title}
                        {change ? (
                          <span className="rounded-full border border-[var(--color-warn)] px-1.5 text-[10px] font-medium text-[var(--color-warn-text)]">
                            {t(`draft.${change}`)}
                          </span>
                        ) : null}
                      </span>
                      {step.assignee ? <span className="text-xs text-[var(--color-muted)]">{step.assignee}</span> : null}
                      {step.body ? <span className="text-xs">{step.body}</span> : null}
                    </span>
                    {onAsk ? (
                      <AskAboutButton
                        where={`${label} · ${t("stepN", { n: index + 1 })}`}
                        text={[step.title, step.body ?? ""].filter(Boolean).join("\n")}
                        onAsk={onAsk}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {changes.removed.length > 0 ? (
            <p data-component="DraftRemoved" className="mt-1.5 text-xs text-[var(--color-muted)] line-through">
              {t("draft.removed", { titles: changes.removed.map((s) => s.title).join(", ") })}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
