"use client";

import { useEffect, useMemo, useState } from "react";

import { ActionError } from "@/components/projects/ActionError";
import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { briefPatch, type BriefState } from "@/components/projects/EditBriefSheet";
import { FileDropZone } from "@/components/projects/inputs/FileDropZone";
import {
  groupInputLinks,
  type LinkEntry,
} from "@/components/projects/inputs/inputKinds";
import { LinkNoteInput } from "@/components/projects/inputs/LinkNoteInput";
import { useUploadQueue } from "@/components/projects/inputs/useUploadQueue";
import { useChangesHistory } from "@/components/projects/iterations/useChangesHistory";
import {
  VersionRail,
  type VersionRow,
} from "@/components/projects/steps/VersionRail";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useT } from "@/i18n";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Pill } from "@/components/ui/Pill";
import { useRefresh, useServerState } from "@/components/ui/useRefresh";
import type { ProjectDirective, ProjectLink } from "@/types";

/**
 * The Requirements step (redesign, frame "Project detail — Requirements
 * step"): the brief as a labelled, editable document — Goal, Sources,
 * Audience, Done when — with the proposed agent edits inline (accept /
 * retire), and a versions column on the right.
 *
 * There is no requirements-version counter on the backend: `v{N}` is
 * derived as `1 + landed requirement changes` (`/changes`), v1 being the
 * first draft. A dirty editor or waiting agent proposals show a pending
 * `v{N+1} · Not saved` row on top of the rail.
 */
export function RequirementsDoc({
  project,
  playbook,
  directives,
  canLead,
}: ProjectTabProps) {
  const t = useT("projects");
  const { refresh } = useRefresh();
  const canEdit = canLead && !project.archived;

  const initial: BriefState = useMemo(
    () => ({
      name: project.name,
      goal: project.goal ?? "",
      description: project.description ?? "",
      target_audience: project.target_audience ?? "",
    }),
    [project],
  );
  const [fields, setFields] = useServerState<BriefState>(initial);
  const dirty = Object.keys(briefPatch(initial, fields)).length > 0;

  const groups = useMemo(() => groupInputLinks(project.links), [project.links]);
  const sources = useMemo(
    () => [...groups.files, ...groups.links, ...groups.memories],
    [groups],
  );
  const proposed = useMemo<ProjectDirective[]>(
    () => directives?.proposed ?? [],
    [directives],
  );

  const history = useChangesHistory(project.slug, project);
  const changes = useMemo(() => history?.changes ?? [], [history]);
  // Real versions (explicit Save-as-vN snapshots, Yan's decision); the
  // counter falls back to the derived count on builds without any.
  const slugPath = `/api/projects/${encodeURIComponent(project.slug)}`;
  const [reqRevs, setReqRevs] = useState<import("@/types").ProjectRequirementRev[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${slugPath}/requirements/versions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setReqRevs(d.revisions ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.slug]);
  const currentRev = reqRevs?.length ? reqRevs[0].rev : 1 + changes.length;

  const saveAction = useProjectAction();
  const directiveAction = useProjectAction();
  const linkAction = useProjectAction();
  const [attachOpen, setAttachOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const queue = useUploadQueue({
    autoUploadSlug: canEdit ? project.slug : undefined,
    dropDone: true,
    onUploaded: () => refresh(),
  });

  async function save() {
    const body = briefPatch(initial, fields);
    const result = await saveAction.run(`${slugPath}/requirements/versions`, {
      body: {
        goal: fields.goal,
        description: fields.description,
        audience: fields.target_audience,
      },
    });
    if (!result?.ok) return;
    if (Object.keys(body).length) {
      await saveAction.run(slugPath, { method: "PATCH", body });
    }
  }

  async function answerDirective(id: string, action: "activate" | "retire") {
    await directiveAction.run(
      `${slugPath}/directives/${encodeURIComponent(id)}/${action}`,
      { method: "POST" },
    );
  }

  async function addLink(entry: LinkEntry) {
    const result = await linkAction.run(`${slugPath}/links`, { body: entry });
    return Boolean(result?.ok);
  }

  const versionRows = useMemo<VersionRow[]>(() => {
    const rows: VersionRow[] = [];
    if (dirty || proposed.length > 0) {
      rows.push({
        rev: currentRev + 1,
        pending: true,
        note: t("reqDoc.notSavedYet"),
        waiting:
          proposed.length > 0
            ? t("reqDoc.agentEdits", { count: proposed.length })
            : null,
      });
    }
    if (reqRevs?.length) {
      reqRevs.forEach((r, i) => {
        rows.push({
          rev: r.rev,
          current: i === 0,
          note: r.note ?? firstLine(r.goal ?? ""),
          author: r.created_by,
          at: r.created_at,
        });
      });
    } else if (changes.length === 0) {
      rows.push({ rev: 1, current: true, note: t("reqDoc.firstDraft") });
    } else {
      changes.forEach((c, i) => {
        rows.push({
          rev: currentRev - i,
          current: i === 0,
          note: firstLine(c.body),
          author: c.author_user_id,
          at: c.created_at,
        });
      });
      rows.push({ rev: 1, note: t("reqDoc.firstDraft") });
    }
    return rows;
  }, [dirty, proposed.length, changes, currentRev, reqRevs, t]);

  return (
    <div
      data-component="RequirementsDoc"
      className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]"
    >
      <div className="flex min-w-0 flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        {/* Header: title · version · dirty flag, Attach / Discard / Save */}
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{t("reqDoc.title")}</h2>
          <Pill tone="accent">v{currentRev}</Pill>
          {dirty ? (
            <Pill tone="warning">{t("reqDoc.unsaved")}</Pill>
          ) : null}
          <span className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAttachOpen(true)}
              disabled={!canEdit}
              data-appmcp-hint="Attach files, links or memories to this project"
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {t("reqDoc.attach")}
            </button>
            {dirty ? (
              <button
                type="button"
                onClick={() => setFields(initial)}
                disabled={saveAction.busy}
                data-appmcp-hint="Discard your unsaved requirement edits"
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-muted)] disabled:opacity-50"
              >
                {t("reqDoc.discard")}
              </button>
            ) : null}
            <BusyRegion busy={saveAction.busy} label={t("reqDoc.saving")}>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canEdit || !dirty || saveAction.busy}
                data-action="save-requirements"
                data-appmcp-hint="Save the document as the next requirements version"
                className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                {t("reqDoc.saveAs", { rev: currentRev + 1 })}
              </button>
            </BusyRegion>
          </span>
        </div>

        <DocSection label={t("reqDoc.goal")}>
          <EditableText
            value={fields.goal}
            onChange={(goal) => setFields((p) => ({ ...p, goal }))}
            disabled={!canEdit}
            rows={2}
            testId="req-goal"
            hint="Edit the project goal"
          />
        </DocSection>

        <DocSection label={t("reqDoc.sources")}>
          {sources.length ? (
            <ul className="flex flex-wrap gap-1.5" data-testid="req-sources">
              {sources.map((l) => (
                <li key={`${l.kind}:${l.ref}`} title={l.label ?? l.ref}>
                  <Pill tone="muted">
                    <span className="font-semibold">{sourceTag(l)}</span>{" "}
                    {sourceName(l)}
                  </Pill>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">
              {t("reqDoc.noSources")}
            </p>
          )}
        </DocSection>

        <DocSection label={t("reqDoc.audience")}>
          <EditableText
            value={fields.target_audience}
            onChange={(target_audience) =>
              setFields((p) => ({ ...p, target_audience }))
            }
            disabled={!canEdit}
            rows={1}
            testId="req-audience"
            hint="Edit who the work is for"
          />
        </DocSection>

        <DocSection label={t("reqDoc.doneWhen")}>
          <EditableText
            value={fields.description}
            onChange={(description) =>
              setFields((p) => ({ ...p, description }))
            }
            disabled={!canEdit}
            rows={4}
            bulletPreview
            testId="req-done"
            hint="Edit the done-when rules"
          />
          {/* Agent-proposed rules — accept lands them, reject retires the
              proposal (green "agent edit" rows in the mockup). */}
          {proposed.map((d) => (
            <div
              key={d.id}
              data-testid="req-proposed"
              className="mt-1 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2"
            >
              <Pill tone="success">{t("reqDoc.agent")}</Pill>
              <span className="min-w-0 flex-1 truncate text-sm">
                + {d.body}
              </span>
              <BusyRegion busy={directiveAction.busy} label={t("reqDoc.saving")}>
                <button
                  type="button"
                  onClick={() => void answerDirective(d.id, "activate")}
                  disabled={!canEdit || directiveAction.busy}
                  data-appmcp-hint="Accept the agent's proposed rule"
                  className="text-xs font-semibold text-[var(--color-accent)] disabled:opacity-50"
                >
                  {t("reqDoc.accept")}
                </button>
                <button
                  type="button"
                  onClick={() => void answerDirective(d.id, "retire")}
                  disabled={!canEdit || directiveAction.busy}
                  data-appmcp-hint="Reject the agent's proposed rule"
                  className="ml-2 text-xs font-semibold text-[var(--color-muted)] disabled:opacity-50"
                >
                  {t("reqDoc.reject")}
                </button>
              </BusyRegion>
            </div>
          ))}
        </DocSection>

        {/* Add inputs */}
        {canEdit ? (
          <div className="flex flex-col gap-2">
            <FileDropZone
              compact
              hint={t("reqDoc.drop")}
              chooseLabel={t("reqDoc.chooseFiles")}
              disabled={!canEdit}
              onFiles={(files) => queue.add(files)}
            />
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setLinkOpen((v) => !v)}
                data-appmcp-hint="Add a link or note as a source"
                className="font-semibold text-[var(--color-accent)]"
              >
                {t("reqDoc.addLink")}
              </button>
            </div>
            {linkOpen ? (
              <LinkNoteInput
                busy={linkAction.busy}
                onAdd={async (entry) => {
                  const ok = await addLink(entry);
                  if (ok) setLinkOpen(false);
                  return ok;
                }}
              />
            ) : null}
          </div>
        ) : null}

        <p className="text-xs text-[var(--color-warn-text)]">
          {dirty
            ? t("reqDoc.saveNote", {
                rev: currentRev + 1,
                plan: playbook?.active?.rev
                  ? t("reqDoc.planWillUpdate", { rev: playbook.active.rev })
                  : "",
              })
            : ""}
        </p>

        <ActionError
          action={saveAction}
          className="text-xs text-[var(--color-danger)]"
        />
        <ActionError
          action={directiveAction}
          className="text-xs text-[var(--color-danger)]"
        />
        <ActionError
          action={linkAction}
          className="text-xs text-[var(--color-danger)]"
        />
      </div>

      <VersionRail
        rows={versionRows}
        usedBy={
          <div className="flex flex-col gap-0.5">
            {playbook?.active ? (
              <p>{t("reqDoc.usedByPlan", { rev: playbook.active.rev })}</p>
            ) : null}
            {project.runs[project.runs.length - 1] ? (
              <p>
                {t("reqDoc.usedByRuns", {
                  run: Math.max(...project.runs.map((r) => r.run_no)),
                })}
              </p>
            ) : null}
          </div>
        }
      />

      {attachOpen ? (
        <AddToProjectSheet
          onClose={() => {
            setAttachOpen(false);
            refresh();
          }}
          fixedSlug={project.slug}
          fixedName={project.name}
        />
      ) : null}
    </div>
  );
}

function DocSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {label}
      </h3>
      {children}
    </div>
  );
}

function EditableText({
  value,
  onChange,
  disabled,
  rows,
  bulletPreview,
  testId,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  rows: number;
  bulletPreview?: boolean;
  testId: string;
  hint: string;
}) {
  const lines = value.split("\n").filter((l) => l.trim());
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        data-testid={testId}
        data-appmcp-hint={hint}
        className="w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-70"
      />
      {bulletPreview && lines.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-sm text-[var(--color-muted)]">
          {lines.map((l, i) => (
            <li key={i}>{l.replace(/^[-*•]\s*/, "")}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** `FILE`, `LINK`, `MEM`… — the kind prefix on a sources chip. */
function sourceTag(l: ProjectLink): string {
  switch (l.kind) {
    case "file":
      return "FILE";
    case "memory":
      return "MEM";
    case "sample":
      return "TPL";
    default:
      return "LINK";
  }
}

function sourceName(l: ProjectLink): string {
  if (l.label) return l.label;
  const tail = l.ref.split("/").filter(Boolean).pop() ?? l.ref;
  return tail.length > 30 ? `${tail.slice(0, 28)}…` : tail;
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 78)}…` : line;
}
