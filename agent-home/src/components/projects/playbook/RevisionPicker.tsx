"use client";

import { useT } from "@/i18n";
import type { PlaybookAncestor, PlaybookDraft, PlaybookRev } from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { proposalBase, revisionState } from "@/components/projects/playbook/revisions";

/**
 * The playbook's versions as a row of chips, oldest first (v1 v2 … v5
 * proposed), with the picked one's note, author and date beneath. The
 * active version carries a filled dot; a proposal is labelled, and one
 * based on an older version says so.
 */
export function RevisionPicker({
  revisions,
  discarded = [],
  activeRev,
  selected,
  onSelect,
  drafts = [],
  selectedDraft = null,
  onSelectDraft,
}: {
  revisions: PlaybookRev[];
  discarded?: PlaybookAncestor[];
  activeRev: number | null;
  /** Null before the first version exists: only drafts are listed. */
  selected: PlaybookRev | null;
  onSelect: (rev: number) => void;
  /** Members' working drafts, shown after the versions (no number yet). */
  drafts?: PlaybookDraft[];
  /** The owner of the draft shown instead of a version. */
  selectedDraft?: string | null;
  onSelectDraft?: (userId: string) => void;
}) {
  const t = useT("playbook");
  return (
    <div data-component="RevisionPicker" className="mt-3">
      <div role="group" aria-label={t("versions")} className="flex flex-wrap items-center gap-1.5">
        {revisions.map((rev) => {
          const state = revisionState(rev, activeRev);
          const picked = selectedDraft == null && rev.rev === selected?.rev;
          const { outdated } = proposalBase(rev, revisions, activeRev, discarded);
          return (
            <button
              key={rev.rev}
              type="button"
              data-rev={rev.rev}
              data-state={state}
              data-outdated={outdated ? "true" : undefined}
              aria-pressed={picked}
              aria-label={state === "active" ? t("chipActive", { rev: rev.rev }) : undefined}
              onClick={() => onSelect(rev.rev)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${
                picked
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : state === "proposed"
                    ? "border-dashed border-[var(--color-warn)] text-[var(--color-warn-text)]"
                    : "border-[var(--color-border)] text-[var(--color-text)]"
              }`}
            >
              {state === "active" ? (
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${picked ? "bg-[var(--color-accent-fg)]" : "bg-[var(--color-success)]"}`}
                />
              ) : null}
              {t("chip", { rev: rev.rev })}
              {state === "proposed" ? (
                <span className="font-normal">
                  {outdated ? `${t("chipProposed")} · ${t("chipOutdated")}` : t("chipProposed")}
                </span>
              ) : null}
            </button>
          );
        })}
        {drafts.map((draft) => {
          const picked = draft.user_id === selectedDraft;
          return (
            <button
              key={`draft:${draft.user_id}`}
              type="button"
              data-draft={draft.user_id}
              aria-pressed={picked}
              onClick={() => onSelectDraft?.(draft.user_id)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed px-3 text-xs font-medium ${
                picked
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : "border-[var(--color-warn)] text-[var(--color-warn-text)]"
              }`}
            >
              {t("draft.chip", { who: draft.user_id })}
              <span className="font-normal">
                {draft.base_rev > 0 ? t("draft.from", { rev: draft.base_rev }) : t("draft.fromScratch")}
              </span>
            </button>
          );
        })}
      </div>
      {selectedDraft == null && selected ? <RevisionMeta rev={selected} /> : null}
    </div>
  );
}

/** `v5: “Dedupe by opportunity_id” · by finance · saved 22 Nov 15:05`. */
export function RevisionMeta({ rev }: { rev: PlaybookRev }) {
  const t = useT("playbook");
  const timeLabel = useTimeLabel();
  const parts = [
    rev.note?.trim() ? t("metaNote", { rev: rev.rev, note: rev.note.trim() }) : t("metaPlain", { rev: rev.rev }),
    rev.created_by ? t("by", { who: rev.created_by }) : null,
    rev.base_rev && !rev.active && rev.activated_at == null ? t("basedOn", { base: rev.base_rev }) : null,
    rev.activated_at != null
      ? t("activated", { when: timeLabel(rev.activated_at) })
      : rev.created_at != null
        ? t("saved", { when: timeLabel(rev.created_at) })
        : null,
  ].filter(Boolean);
  return (
    <p data-component="RevisionMeta" className="mt-1.5 text-xs text-[var(--color-muted)]">
      {parts.join(" · ")}
    </p>
  );
}
