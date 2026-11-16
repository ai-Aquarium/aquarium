"use client";

import { useState } from "react";

import { ChevronRightIcon, PlusIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { errorText, sendJson } from "@/lib/admin-fetch";
import { fileName, layerBadge, layerNote, offByTemplate, triageUrl } from "@/lib/triage/layers";
import { useAction } from "@/lib/use-action";
import type { TriageLayeredFile, TriageLayerKind } from "@/types";

import { LayerTag } from "./LayerTag";

export interface TriageFilesCardProps {
  profile: string;
  kind: TriageLayerKind;
  files: TriageLayeredFile[];
  selected: string | null;
  onSelect(key: string): void;
  onAdd(): void;
  onChanged(): Promise<void> | void;
}

/** Every triage file for this kind, which layer wins, and an on/off per file for me. */
export function TriageFilesCard({ profile, kind, files, selected, onSelect, onAdd, onChanged }: TriageFilesCardProps) {
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = useAction(async (file: TriageLayeredFile) => {
    setError(null);
    setToggling(file.key);
    try {
      await sendJson(triageUrl("/disable", profile), "POST", {
        kind,
        layer: "user",
        key: file.key,
        disabled: !file.disabled,
      });
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setToggling(null);
    }
  });

  return (
    <section
      data-component="TriageFilesCard"
      className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <h2 className="text-sm font-semibold">Triage files</h2>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <PlusIcon size={14} />
          Add file
        </button>
      </div>
      <p className="px-4 pb-3 text-xs text-[var(--color-muted)]">
        Wins: Built-in → Template → Mine. Off = turned off for you.
      </p>
      {error ? (
        <InlineAlert tone="danger" className="mx-4 mb-3">
          {error}
        </InlineAlert>
      ) : null}
      {files.length === 0 ? (
        <p className="border-t border-[var(--color-border)] px-4 py-4 text-xs text-[var(--color-muted)]">
          No triage files for this kind yet. Add one to teach {profile} how to sort these messages for you.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {files.map((file) => {
            const name = fileName(file.key);
            const on = !file.disabled;
            const locked = offByTemplate(file);
            return (
              <li
                key={file.key}
                data-file={file.key}
                className={`flex items-center gap-2 pl-4 pr-2 ${selected === file.key ? "bg-[var(--color-surface-2)]" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(file.key)}
                  aria-current={selected === file.key ? "true" : undefined}
                  className="min-w-0 flex-1 py-2.5 text-left"
                >
                  <span className="block truncate text-sm" title={file.key}>
                    {name}
                  </span>
                  <span className="block truncate text-xs text-[var(--color-muted)]">{layerNote(file, profile)}</span>
                </button>
                <LayerTag badge={layerBadge(file)} />
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${name} on for me`}
                  aria-busy={toggling === file.key || undefined}
                  title={locked ? `Off in the ${profile} template. Save your own version to turn it on.` : undefined}
                  disabled={toggle.pending || locked}
                  onClick={() => void toggle.run(file)}
                  className="inline-flex h-11 w-12 shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className={`relative block h-6 w-11 rounded-full transition-colors ${
                      on ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-border)]"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-fg)] transition-all ${
                        on ? "left-[1.375rem]" : "left-0.5"
                      }`}
                    />
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onSelect(file.key)}
                  aria-label={`Open ${name}`}
                  className="inline-flex h-11 w-8 shrink-0 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                >
                  <ChevronRightIcon size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
