"use client";

import { useEffect, useMemo, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ChevronLeftIcon, UndoIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { useConfirm } from "@/components/ui/useConfirm";
import { errorText, getJson, sendJson } from "@/lib/admin-fetch";
import { diffLines, type DiffOp } from "@/lib/skills/diff";
import { timeAgo } from "@/lib/skills/versions";
import { fileName, layerBadge, offByTemplate, triageUrl } from "@/lib/triage/layers";
import type {
  TriageLayerDiff,
  TriageLayeredFile,
  TriageLayerFile,
  TriageLayerHistory,
  TriageLayerKind,
  TriageLayerVersion,
} from "@/types";

import { LayerTag } from "./LayerTag";
import { useReportDirty, type ReportDirty } from "./useUnsavedGuard";

export interface TriageFileViewProps {
  profile: string;
  kind: TriageLayerKind;
  file: TriageLayeredFile;
  userId: string | null;
  /** Bumped by the page after a change elsewhere (e.g. the list's on/off). */
  revision: number;
  onChanged(): Promise<void> | void;
  onDirty: ReportDirty;
  confirmDiscard(): Promise<boolean>;
  /** Phone only: back to the list. */
  onBack(): void;
}

interface Loaded {
  /** The template side: the profile template's text, else Aquarium's built-in. */
  template: { text: string | null; source: "template" | "builtin" | null; off: boolean };
  /** My own text; `null` when I have no version of this file. */
  mine: string | null;
  diff: TriageLayerDiff | null;
  history: TriageLayerVersion[];
  templateHistory: TriageLayerVersion[];
}

const lineBase = "whitespace-pre-wrap break-words border-l-2 py-0.5 pl-3";
const LINE: Record<DiffOp["type"], string> = {
  same: `${lineBase} border-[var(--color-border)]`,
  del: `${lineBase} border-[var(--color-danger)] text-[var(--color-danger)]`,
  add: `${lineBase} border-[var(--color-success)] text-[var(--color-success)]`,
};
const PREFIX: Record<DiffOp["type"], string> = { same: "", del: "- ", add: "+ " };

async function viewOf(profile: string, kind: string, key: string, layer: string): Promise<TriageLayerFile | null> {
  return getJson<TriageLayerFile>(triageUrl("/file", profile, { kind, key, layer })).catch(() => null);
}

async function historyOf(profile: string, kind: string, key: string, layer: string): Promise<TriageLayerVersion[]> {
  const res = await getJson<TriageLayerHistory>(triageUrl("/history", profile, { kind, key, layer })).catch(() => null);
  return [...(res?.versions ?? [])].sort((a, b) => b.at - a.at);
}

/** One triage file: template beside mine (desktop) or a unified diff (phone), my edits and history. */
export function TriageFileView(props: TriageFileViewProps) {
  const { profile, kind, file, userId, revision, onChanged, onDirty, confirmDiscard, onBack } = props;
  const name = fileName(file.key);
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [viewing, setViewing] = useState<TriageLayerVersion | null>(null);
  const { ask, dialog } = useConfirm();
  const editing = draft !== null;
  const original = data?.mine ?? data?.template.text ?? "";
  const dirty = editing && draft !== original;
  useReportDirty(`file:${file.key}`, dirty, onDirty);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [tpl, mine, diff, history, templateHistory] = await Promise.all([
          viewOf(profile, kind, file.key, "template"),
          file.layers.user === "content" ? viewOf(profile, kind, file.key, "user") : Promise.resolve(null),
          getJson<TriageLayerDiff>(triageUrl("/diff", profile, { kind, key: file.key })).catch(() => null),
          historyOf(profile, kind, file.key, "user"),
          historyOf(profile, kind, file.key, "template"),
        ]);
        let template: Loaded["template"] = { text: null, source: null, off: tpl?.state === "disabled" };
        if (tpl?.state === "content") template = { text: tpl.content, source: "template", off: false };
        else if (!template.off && file.layers.builtin === "content") {
          const builtin = await viewOf(profile, kind, file.key, "builtin");
          template = { text: builtin?.content ?? null, source: "builtin", off: false };
        }
        if (!live) return;
        setData({ template, mine: mine?.content ?? null, diff, history, templateHistory });
        setLoadError(null);
      } catch (err) {
        if (live) setLoadError(errorText(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [profile, kind, file.key, file.layers.user, file.layers.builtin, revision, reloads]);

  const ops = useMemo(
    () => (data ? diffLines(data.template.text ?? "", data.mine ?? data.template.text ?? "") : []),
    [data],
  );

  async function afterWrite(text: string) {
    setNote({ tone: "success", text });
    setReloads((n) => n + 1);
    await onChanged();
  }

  async function saveMine() {
    if (draft === null) return;
    setNote(null);
    try {
      await sendJson(triageUrl("/file", profile), "PUT", { kind, layer: "user", key: file.key, content: draft });
      setDraft(null);
      await afterWrite(`Saved. Your version of ${name} now wins.`);
    } catch (err) {
      setNote({ tone: "danger", text: errorText(err) });
    }
  }

  async function setOff(off: boolean) {
    setNote(null);
    try {
      await sendJson(triageUrl("/disable", profile), "POST", { kind, layer: "user", key: file.key, disabled: off });
      await afterWrite(off ? `${name} is off for you. Triage skips it.` : `${name} is on again for you.`);
    } catch (err) {
      setNote({ tone: "danger", text: errorText(err) });
    }
  }

  const onlyMine = file.layers.template === undefined && file.layers.builtin === undefined;

  async function reset() {
    const ok = await ask(
      onlyMine
        ? {
            title: `Remove ${name}?`,
            body: "This file is only yours, so there is no template to go back to. It stays in History, so you can bring it back.",
            confirmLabel: "Remove",
            tone: "danger",
          }
        : {
            title: `Reset ${name} to the template?`,
            body: `Your version of this file is replaced by the ${profile} template. It stays in History, so you can bring it back.`,
            confirmLabel: "Reset to template",
            tone: "danger",
          },
    );
    if (!ok) return;
    setNote(null);
    try {
      await sendJson(triageUrl("/reset", profile), "POST", { kind, key: file.key });
      setDraft(null);
      await afterWrite(onlyMine ? `${name} is removed.` : `${name} is back to the template.`);
    } catch (err) {
      setNote({ tone: "danger", text: errorText(err) });
    }
  }

  async function startEdit(text: string) {
    if (dirty && !(await confirmDiscard())) return;
    setNote(null);
    setViewing(null);
    setDraft(text);
  }

  const badge = layerBadge(file);
  const lockedOff = offByTemplate(file);
  const templateChanged = data?.templateHistory.find((v) => v.action !== "baseline");
  const myLatest = data?.history[0];
  const summary =
    badge === "mine"
      ? `Your version wins.${templateChanged ? ` Template changed ${timeAgo(templateChanged.at)}.` : ""}`
      : badge === "template"
        ? "The template's version is used. Edit my version to make your own."
        : badge === "builtin"
          ? "Aquarium's built-in version is used. Edit my version to make your own."
          : lockedOff
            ? `Turned off in the ${profile} template. Save your own version to use it.`
            : "Turned off for you: triage skips this file.";
  const templateLabel =
    data?.template.source === "template"
      ? `${profile}${data.templateHistory.length ? ` · v${data.templateHistory.length}` : ""}`
      : data?.template.source === "builtin"
        ? "Built-in"
        : "";

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] lg:hidden"
      >
        <ChevronLeftIcon size={16} />
        All triage files
      </button>
      <section
        data-component="TriageFileView"
        data-file={file.key}
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold" title={file.key}>
              {name}
            </h2>
            <p className="text-xs text-[var(--color-muted)]">{summary}</p>
          </div>
          <LayerTag badge={badge} />
        </div>

        {loadError ? (
          <InlineAlert tone="danger" className="mt-3">
            {loadError}
          </InlineAlert>
        ) : !data ? (
          <p className="mt-4 text-xs text-[var(--color-muted)]">Loading {name}…</p>
        ) : editing ? (
          <div className="mt-3">
            <label htmlFor={`edit-${file.key}`} className="text-xs font-medium">
              My version
            </label>
            <textarea
              id={`edit-${file.key}`}
              value={draft ?? ""}
              onChange={(e) => setDraft(e.target.value)}
              rows={12}
              autoFocus
              className={`${inputClass} mt-1 resize-y font-mono text-xs leading-relaxed`}
            />
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Saving makes your own version of {name}. It only changes how {profile} sorts messages for you; the template
              and everyone else stay as they are.
            </p>
            {!draft?.trim() ? (
              <p className="mt-1 text-xs text-[var(--color-danger)]">
                A file can&apos;t be empty. To stop using it, cancel and turn it off for you.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="mt-3 hidden gap-3 lg:grid lg:grid-cols-2" data-slot="side-by-side">
              <DiffPanel
                title="Template"
                aside={templateLabel}
                lines={data.template.off ? [] : ops.filter((op) => op.type !== "add")}
                empty={
                  data.template.off
                    ? `Turned off in the ${profile} template.`
                    : data.template.text === null
                      ? `Not in the ${profile} template: this file is only yours.`
                      : "Empty."
                }
              />
              <DiffPanel
                title="Mine"
                aside={data.mine === null ? "same as template" : myLatest ? `edited ${timeAgo(myLatest.at)}` : "edited"}
                lines={ops.filter((op) => op.type !== "del")}
                empty="Empty."
              />
            </div>
            <div className="mt-3 lg:hidden" data-slot="unified">
              <UnifiedDiff diff={data.diff} fallback={data.mine ?? data.template.text ?? ""} />
            </div>
          </>
        )}

        {note ? (
          <InlineAlert tone={note.tone} className="mt-3">
            {note.text}
          </InlineAlert>
        ) : null}

        {data ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <ActionButton
                  onAction={saveMine}
                  disabled={!dirty || !draft?.trim()}
                  busyLabel="Saving…"
                  className={`${primaryButtonClass} min-h-11`}
                >
                  Save my version
                </ActionButton>
                <button
                  type="button"
                  onClick={() =>
                    void (async () => {
                      if (dirty && !(await confirmDiscard())) return;
                      setDraft(null);
                    })()
                  }
                  className={`${secondaryButtonClass} min-h-11`}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void startEdit(original)}
                  className={`${secondaryButtonClass} min-h-11 bg-[var(--color-surface-2)]`}
                >
                  Edit my version
                </button>
                {!lockedOff ? (
                  <ActionButton
                    onAction={() => setOff(!file.disabled)}
                    busyLabel={file.disabled ? "Turning on…" : "Turning off…"}
                    className="min-h-11 rounded-full px-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-60"
                  >
                    {file.disabled ? "Turn on for me" : "Turn off for me"}
                  </ActionButton>
                ) : null}
                {file.layers.user ? (
                  <ActionButton
                    onAction={reset}
                    busyLabel={onlyMine ? "Removing…" : "Resetting…"}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-60 lg:ml-auto"
                  >
                    <UndoIcon size={14} />
                    {onlyMine ? "Remove my file" : "Reset to template"}
                  </ActionButton>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </section>

      {data ? (
        <section
          data-component="TriageFileHistory"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-sm font-semibold">History · my version</h2>
          {data.history.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              No versions of your own yet. Your first edit starts the history.
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-[var(--color-border)]">
              {data.history.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{v.message || ACTION_LABEL[v.action]}</p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {timeAgo(v.at)} · {authorName(v.author, userId)} · {ACTION_LABEL[v.action].toLowerCase()}
                    </p>
                  </div>
                  {v.content !== null ? (
                    <button
                      type="button"
                      onClick={() => setViewing(v)}
                      className="min-h-11 shrink-0 px-2 text-sm text-[var(--color-accent)]"
                    >
                      View
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {viewing ? (
        <Sheet
          title={`${name} · ${timeAgo(viewing.at)}`}
          onClose={() => setViewing(null)}
          wide
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setViewing(null)} className={`${secondaryButtonClass} min-h-11`}>
                Close
              </button>
              <button
                type="button"
                onClick={() => void startEdit(viewing.content ?? "")}
                className={`${primaryButtonClass} min-h-11`}
              >
                Edit from this version
              </button>
            </div>
          }
        >
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            A saved copy of your version. Edit from it to bring it back; nothing changes until you save.
          </p>
          <pre className="whitespace-pre-wrap break-words rounded-xl bg-[var(--color-bg)] p-3 font-mono text-xs leading-relaxed">
            {viewing.content}
          </pre>
        </Sheet>
      ) : null}
      {dialog}
    </>
  );
}

const ACTION_LABEL: Record<TriageLayerVersion["action"], string> = {
  baseline: "Before your first edit",
  edit: "Edit",
  disable: "Turned off",
  enable: "Turned on",
  reset: "Reset to template",
};

function authorName(author: string, userId: string | null): string {
  if (userId && author === `user:${userId}`) return "You";
  if (author === "system") return "Aquarium";
  if (author.startsWith("user:")) return "Someone else";
  return author.split(":")[0] || "unknown";
}

function DiffPanel({ title, aside, lines, empty }: { title: string; aside: string; lines: DiffOp[]; empty: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3" data-panel={title}>
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{title}</span>
        <span className="truncate text-[var(--color-muted)]">{aside}</span>
      </div>
      {lines.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">{empty}</p>
      ) : (
        <div className="space-y-1 font-mono text-xs leading-relaxed">
          {lines.map((op, i) => (
            <div key={i} className={LINE[op.type]} data-op={op.type}>
              {PREFIX[op.type]}
              {op.text || " "}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UnifiedDiff({ diff, fallback }: { diff: TriageLayerDiff | null; fallback: string }) {
  const lines =
    diff?.changed && diff.diff
      ? diff.diff
          .split("\n")
          .filter((l) => l && !l.startsWith("---") && !l.startsWith("+++"))
          .filter((l, i) => i > 0 || !l.startsWith("@@"))
          .map((l) =>
            l.startsWith("@@")
              ? { type: "hunk" as const, text: l }
              : { type: (l[0] === "+" ? "add" : l[0] === "-" ? "del" : "same") as DiffOp["type"], text: l.slice(1) },
          )
      : null;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium">Diff</span>
        <span className="text-[var(--color-muted)]">template → mine</span>
      </div>
      {lines ? (
        <div className="space-y-1 font-mono text-xs leading-relaxed">
          {lines.map((l, i) =>
            l.type === "hunk" ? (
              <div key={i} aria-label="Unchanged lines skipped" className="pl-3 text-[var(--color-muted)]">
                ⋯
              </div>
            ) : (
              <div key={i} className={LINE[l.type]} data-op={l.type}>
                {PREFIX[l.type]}
                {l.text || " "}
              </div>
            ),
          )}
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs text-[var(--color-muted)]">No differences: you use the template&apos;s text.</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{fallback}</pre>
        </>
      )}
    </div>
  );
}
