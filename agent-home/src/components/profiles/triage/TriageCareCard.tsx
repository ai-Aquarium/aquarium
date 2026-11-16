"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { UndoIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { inputClass, primaryButtonClass } from "@/components/ui/Sheet";
import { errorText, sendJson } from "@/lib/admin-fetch";
import { byteLength, CARE_MAX_BYTES, CARE_MAX_CHARS, layerBadge, triageUrl } from "@/lib/triage/layers";
import type { TriageCareSection, TriageCareWriteResult, TriageLayerKind } from "@/types";

import { LayerTag } from "./LayerTag";
import { useReportDirty, type ReportDirty } from "./useUnsavedGuard";

export interface TriageCareCardProps {
  profile: string;
  kind: TriageLayerKind;
  care: TriageCareSection;
  onDirty: ReportDirty;
}

/** "What I care about": the one section the quick check reads per batch. */
export function TriageCareCard({ profile, kind, care, onDirty }: TriageCareCardProps) {
  const [saved, setSaved] = useState(care);
  const [draft, setDraft] = useState(care.content);
  const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const dirty = draft !== saved.content;
  const empty = !draft.trim();
  const tooLong = draft.length > CARE_MAX_CHARS || byteLength(draft) > CARE_MAX_BYTES;
  const template = care.template;
  useReportDirty("care", dirty, onDirty);

  async function save() {
    setNote(null);
    try {
      const res = await sendJson<TriageCareWriteResult>(triageUrl("/care", profile), "PUT", {
        kind,
        layer: "user",
        content: draft,
      });
      setSaved(res.care);
      setDraft(res.care.content);
      setNote({ tone: "success", text: "Saved. The next batch is checked against your text." });
    } catch (err) {
      setNote({ tone: "danger", text: errorText(err) });
    }
  }

  return (
    <section
      data-component="TriageCareCard"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">What I care about</h2>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-warn)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--color-warn-text)]">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            Required
          </span>
          <LayerTag badge={layerBadge({ layer: saved.layer, disabled: false })} />
        </div>
      </div>
      <label className="sr-only" htmlFor={`care-${kind}`}>
        What I care about
      </label>
      <textarea
        id={`care-${kind}`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setNote(null);
        }}
        rows={4}
        aria-invalid={empty || tooLong}
        placeholder="e.g. Invoices and payment requests for Acme Ltd. Anything about cash flow or due dates. Not: newsletters."
        className={`${inputClass} mt-3 resize-y leading-relaxed`}
      />
      <p className={`mt-2 text-xs ${empty || tooLong ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
        {empty
          ? "Required: write a line or two about what should reach you."
          : tooLong
            ? "That's too long for the quick check. Keep it under 2000 characters."
            : `The quick check reads only this section to decide whether ${profile} gets a batch. Keep it short and concrete.`}{" "}
        <span data-slot="care-count">
          {draft.length} / {CARE_MAX_CHARS}
        </span>
      </p>
      {saved.layer !== "user" ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          You are using the {saved.layer === "template" ? `${profile} template's` : "built-in"} text. Saving makes it yours.
        </p>
      ) : null}
      {note ? (
        <InlineAlert tone={note.tone} className="mt-3">
          {note.text}
        </InlineAlert>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        {template && template.content !== draft ? (
          <button
            type="button"
            onClick={() => {
              setDraft(template.content);
              setNote(null);
            }}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            <UndoIcon size={14} />
            Use template text
          </button>
        ) : (
          <span />
        )}
        <ActionButton
          onAction={save}
          disabled={!dirty || empty || tooLong}
          busyLabel="Saving…"
          className={`${primaryButtonClass} min-h-11 px-5`}
        >
          Save
        </ActionButton>
      </div>
    </section>
  );
}
