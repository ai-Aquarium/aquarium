"use client";

import { useCallback, useEffect, useState } from "react";

import { PencilIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { useConfirm } from "@/components/ui/useConfirm";
import { errorText, getJson } from "@/lib/admin-fetch";
import { TRIAGE_TABS, triageUrl } from "@/lib/triage/layers";
import type { TriageLayerKind, TriageLayers } from "@/types";

import { TriageCareCard } from "./TriageCareCard";
import { AddTriageFileSheet, EditTriageTemplateSheet } from "./TriageFileSheets";
import { TriageFilesCard } from "./TriageFilesCard";
import { TriageFileView } from "./TriageFileView";
import { useUnsavedGuard } from "./useUnsavedGuard";

export interface TriageSkillsViewProps {
  profile: string;
  initialKind: TriageLayerKind;
}

/** Profile › My triage skills: my layer over the profile template, per triage kind. */
export function TriageSkillsView({ profile, initialKind }: TriageSkillsViewProps) {
  const [kind, setKind] = useState(initialKind);
  const [data, setData] = useState<TriageLayers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [phoneFile, setPhoneFile] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sheet, setSheet] = useState<"add" | "template" | null>(null);
  const [dirtyParts, setDirtyParts] = useState<Record<string, boolean>>({});
  const { ask, dialog } = useConfirm();
  const confirmDiscard = useUnsavedGuard(Object.values(dirtyParts).some(Boolean), ask);

  const reportDirty = useCallback(
    (part: string, dirty: boolean) => setDirtyParts((prev) => (Boolean(prev[part]) === dirty ? prev : { ...prev, [part]: dirty })),
    [],
  );

  const load = useCallback(async () => {
    const next = await getJson<TriageLayers>(triageUrl("", profile, { kind }));
    setData(next);
    setError(null);
    setSelected((cur) => (cur && next.files.some((f) => f.key === cur) ? cur : (next.files[0]?.key ?? null)));
    return next;
  }, [profile, kind]);

  useEffect(() => {
    let live = true;
    getJson<TriageLayers>(triageUrl("", profile, { kind }))
      .then((next) => {
        if (!live) return;
        setData(next);
        setError(null);
        setSelected((cur) => (cur && next.files.some((f) => f.key === cur) ? cur : (next.files[0]?.key ?? null)));
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [profile, kind]);

  const changed = useCallback(async () => {
    try {
      await load();
      setRevision((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    }
  }, [load]);

  async function switchKind(next: TriageLayerKind) {
    if (next === kind || !(await confirmDiscard())) return;
    setData(null);
    setError(null);
    setSelected(null);
    setPhoneFile(false);
    setSheet(null);
    setKind(next);
    window.history.replaceState(window.history.state, "", `?kind=${next}`);
  }

  async function openFile(key: string) {
    if (key !== selected && !(await confirmDiscard())) return;
    setSelected(key);
    setPhoneFile(true);
  }

  const file = data?.files.find((f) => f.key === selected) ?? null;
  const ready = data && data.kind === kind ? data : null;

  return (
    <div data-component="TriageSkillsView" className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Triage kind"
        className="flex w-full gap-1 self-start rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1 sm:w-auto"
      >
        {TRIAGE_TABS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            role="tab"
            aria-selected={tab.kind === kind}
            onClick={() => void switchKind(tab.kind)}
            className={`min-h-9 flex-1 rounded-full px-3 text-sm sm:flex-none ${
              tab.kind === kind
                ? "bg-[var(--color-surface-2)] font-medium text-[var(--color-fg)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {kind === "calendar" ? (
        <p className="text-xs text-[var(--color-muted)]">
          Calendar has no source to connect: these files decide how {profile} sorts your calendar events.
        </p>
      ) : null}

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      {!ready ? (
        error ? null : <PageSkeleton rows={3} />
      ) : (
        <>
          {ready.can_edit_template ? (
            <section
              data-slot="template-owner"
              className="flex flex-col gap-3 rounded-2xl border border-[var(--color-accent)]/60 bg-[var(--color-surface)] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <h2 className="text-sm font-semibold">You manage {profile}</h2>
                <p className="text-xs text-[var(--color-muted)]">
                  You can also edit the template that every {profile} user starts from. Their own versions still win.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSheet("template")}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm sm:self-auto"
              >
                <PencilIcon size={14} />
                Edit template
              </button>
            </section>
          ) : (
            <section
              data-slot="template-readonly"
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <h2 className="text-sm font-semibold">The {profile} template is read-only for you</h2>
              <p className="text-xs text-[var(--color-muted)]">
                Only {profile}&apos;s owners and admins can change the template. You can change your own version; it sits
                on top and never affects anyone else.
              </p>
            </section>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,5fr)] lg:items-start">
            <div className={`${phoneFile && file ? "hidden lg:flex" : "flex"} flex-col gap-4`}>
              <TriageCareCard key={kind} profile={profile} kind={kind} care={ready.care} onDirty={reportDirty} />
              <TriageFilesCard
                profile={profile}
                kind={kind}
                files={ready.files}
                selected={selected}
                onSelect={(key) => void openFile(key)}
                onAdd={() => setSheet("add")}
                onChanged={changed}
              />
            </div>
            <div className={`${phoneFile && file ? "flex" : "hidden lg:flex"} min-w-0 flex-col gap-4`}>
              {file ? (
                <TriageFileView
                  key={`${kind}:${file.key}`}
                  profile={profile}
                  kind={kind}
                  file={file}
                  userId={ready.user_id}
                  revision={revision}
                  onChanged={changed}
                  onDirty={reportDirty}
                  confirmDiscard={confirmDiscard}
                  onBack={() => setPhoneFile(false)}
                />
              ) : (
                <p className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
                  Pick a triage file to see the template beside your version.
                </p>
              )}
            </div>
          </div>

          {sheet === "add" ? (
            <AddTriageFileSheet
              profile={profile}
              kind={kind}
              existing={ready.files.map((f) => f.key)}
              onClose={() => setSheet(null)}
              onDirty={reportDirty}
              onSaved={async (key) => {
                setSheet(null);
                setSelected(key);
                await changed();
              }}
            />
          ) : null}
          {sheet === "template" && ready.can_edit_template ? (
            <EditTriageTemplateSheet
              profile={profile}
              kind={kind}
              files={ready.files}
              initialKey={selected}
              onClose={() => setSheet(null)}
              onDirty={reportDirty}
              onSaved={changed}
            />
          ) : null}
        </>
      )}
      {dialog}
    </div>
  );
}
