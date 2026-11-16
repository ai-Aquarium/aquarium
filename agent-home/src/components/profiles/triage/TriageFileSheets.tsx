"use client";

import { useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { useConfirm } from "@/components/ui/useConfirm";
import { errorText, getJson, sendJson } from "@/lib/admin-fetch";
import { fileName, newFileKey, triageUrl } from "@/lib/triage/layers";
import type { TriageLayeredFile, TriageLayerFile, TriageLayerKind } from "@/types";

import { useReportDirty, type ReportDirty } from "./useUnsavedGuard";

const DISCARD = {
  title: "Discard unsaved changes?",
  body: "What you typed here is lost if you close now.",
  confirmLabel: "Discard",
  tone: "danger" as const,
};

export interface AddTriageFileSheetProps {
  profile: string;
  kind: TriageLayerKind;
  existing: readonly string[];
  onClose(): void;
  onSaved(key: string): Promise<void> | void;
  onDirty: ReportDirty;
}

/** A file only I get: Hermes' user layer accepts a new `<name>.md` key. */
export function AddTriageFileSheet({ profile, kind, existing, onClose, onSaved, onDirty }: AddTriageFileSheetProps) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  const dirty = Boolean(name.trim() || content.trim());
  const check = newFileKey(name, existing);
  useReportDirty("add-file", dirty, onDirty);

  async function close() {
    if (dirty && !(await ask(DISCARD))) return;
    onClose();
  }

  async function save() {
    if (!check.key) return;
    setError(null);
    try {
      await sendJson(triageUrl("/file", profile), "PUT", { kind, layer: "user", key: check.key, content });
      await onSaved(check.key);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Sheet
      title="Add a triage file"
      onClose={() => void close()}
      component="AddTriageFileSheet"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => void close()} className={`${secondaryButtonClass} min-h-11`}>
            Cancel
          </button>
          <ActionButton
            onAction={save}
            disabled={!check.key || !content.trim()}
            busyLabel="Adding…"
            className={`${primaryButtonClass} min-h-11`}
          >
            Add file
          </ActionButton>
        </div>
      }
    >
      <p className="text-xs text-[var(--color-muted)]">
        Only you get this file. It adds to how {profile} sorts these messages for you and never changes the template or
        anyone else&apos;s triage.
      </p>
      <label className="mt-3 block text-xs font-medium" htmlFor="triage-new-name">
        File name
      </label>
      <input
        id="triage-new-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="vip-senders.md"
        autoFocus
        className={`${inputClass} mt-1 font-mono`}
      />
      <p className={`mt-1 text-xs ${name.trim() && check.error ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
        {name.trim() && check.error ? check.error : "Ends in .md; we add it if you leave it out."}
      </p>
      <label className="mt-3 block text-xs font-medium" htmlFor="triage-new-content">
        What it says
      </label>
      <textarea
        id="triage-new-content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={8}
        placeholder={"e.g. Mail from anyone at kowloon-freight.com is always a to-do."}
        className={`${inputClass} mt-1 resize-y font-mono text-xs leading-relaxed`}
      />
      {error ? (
        <InlineAlert tone="danger" className="mt-3">
          {error}
        </InlineAlert>
      ) : null}
      {dialog}
    </Sheet>
  );
}

export interface EditTriageTemplateSheetProps {
  profile: string;
  kind: TriageLayerKind;
  files: TriageLayeredFile[];
  initialKey: string | null;
  onClose(): void;
  onSaved(): Promise<void> | void;
  onDirty: ReportDirty;
}

/** Owners/admins only: the text every user of this profile starts from. */
export function EditTriageTemplateSheet({
  profile,
  kind,
  files,
  initialKey,
  onClose,
  onSaved,
  onDirty,
}: EditTriageTemplateSheetProps) {
  const shared = files.filter((f) => f.layers.template !== undefined || f.layers.builtin !== undefined);
  const [key, setKey] = useState(
    initialKey && shared.some((f) => f.key === initialKey) ? initialKey : (shared[0]?.key ?? null),
  );
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  const dirty = original !== null && draft !== original;
  useReportDirty("template", dirty, onDirty);

  useEffect(() => {
    if (!key) return;
    let live = true;
    void (async () => {
      try {
        const file = files.find((f) => f.key === key);
        const layer = file?.layers.template === "content" || !file?.layers.builtin ? "template" : "builtin";
        const view = await getJson<TriageLayerFile>(triageUrl("/file", profile, { kind, key, layer }));
        if (!live) return;
        setOriginal(view.content ?? "");
        setDraft(view.content ?? "");
        setError(null);
      } catch (err) {
        if (live) setError(errorText(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [profile, kind, key, files]);

  async function close() {
    if (dirty && !(await ask(DISCARD))) return;
    onClose();
  }

  async function pick(next: string) {
    if (dirty && !(await ask(DISCARD))) return;
    setNote(null);
    setOriginal(null);
    setKey(next);
  }

  async function save() {
    if (!key) return;
    setError(null);
    try {
      await sendJson(triageUrl("/file", profile), "PUT", { kind, layer: "template", key, content: draft });
      setOriginal(draft);
      setNote(`Template saved. ${profile} users without their own version get it from their next batch.`);
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Sheet
      title={`Edit the ${profile} template`}
      onClose={() => void close()}
      wide
      component="EditTriageTemplateSheet"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => void close()} className={`${secondaryButtonClass} min-h-11`}>
            Close
          </button>
          <ActionButton
            onAction={save}
            disabled={!dirty || !draft.trim()}
            busyLabel="Saving…"
            className={`${primaryButtonClass} min-h-11`}
          >
            Save template
          </ActionButton>
        </div>
      }
    >
      <p className="text-xs text-[var(--color-muted)]">
        Every {profile} user starts from the template. Anyone who has their own version of a file keeps it.
      </p>
      {shared.length === 0 ? (
        <p className="mt-3 text-sm">There are no template files for this kind yet.</p>
      ) : (
        <>
          <label className="mt-3 block text-xs font-medium" htmlFor="triage-template-file">
            File
          </label>
          <select
            id="triage-template-file"
            value={key ?? ""}
            onChange={(e) => void pick(e.target.value)}
            className={`${inputClass} mt-1`}
          >
            {shared.map((f) => (
              <option key={f.key} value={f.key}>
                {fileName(f.key)}
              </option>
            ))}
          </select>
          <label className="mt-3 block text-xs font-medium" htmlFor="triage-template-text">
            Template text
          </label>
          <textarea
            id="triage-template-text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setNote(null);
            }}
            disabled={original === null}
            rows={12}
            className={`${inputClass} mt-1 resize-y font-mono text-xs leading-relaxed`}
          />
          {original === null && !error ? <p className="mt-1 text-xs text-[var(--color-muted)]">Loading…</p> : null}
        </>
      )}
      {note ? (
        <InlineAlert tone="success" className="mt-3">
          {note}
        </InlineAlert>
      ) : null}
      {error ? (
        <InlineAlert tone="danger" className="mt-3">
          {error}
        </InlineAlert>
      ) : null}
      {dialog}
    </Sheet>
  );
}
