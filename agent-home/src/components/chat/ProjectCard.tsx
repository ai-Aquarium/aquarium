"use client";

import { useEffect, useState } from "react";

import {
  newIdempotencyKey,
  sendProjectAction,
} from "@/components/projects/useProjectAction";
import { useT } from "@/i18n";
import type { ProjectCardRef } from "@/lib/chat/project-card";
import type { ProjectDetail, ProjectPlaybookResponse } from "@/types";

type Loaded = {
  project: Pick<ProjectDetail, "name" | "ref" | "status" | "can_write" | "runs">;
  /** The newest revision still waiting for a Make active. */
  proposed: number | null;
  activeRev: number | null;
};

type Started = { runNo: number | null };

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function projectHref(slug: string, rev: number | null): string {
  const q = new URLSearchParams({ tab: "planning", chat: "open" });
  if (rev != null) q.set("rev", String(rev));
  return `/projects/${encodeURIComponent(slug)}?${q.toString()}`;
}

/**
 * The card an agent's reply carries after starting a project from the chat:
 * the project, its proposed playbook, Open project and — for someone who can
 * make it active — Make active & run 1. The agent never does either itself.
 */
export function ProjectCard({ card }: { card: ProjectCardRef }) {
  const t = useT("projects");
  const base = `/api/projects/${encodeURIComponent(card.slug)}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<Started | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([
      getJson<ProjectDetail>(base),
      getJson<ProjectPlaybookResponse>(`${base}/playbook`),
    ]).then(([project, playbook]) => {
      if (!live) return;
      if (!project) {
        setMissing(true);
        return;
      }
      const activeRev = playbook?.active?.rev ?? null;
      const waiting = (playbook?.revisions ?? [])
        .filter((r) => !r.active && (activeRev == null || r.rev > activeRev))
        .map((r) => r.rev);
      setLoaded({
        project,
        proposed: waiting.length ? Math.max(...waiting) : null,
        activeRev,
      });
    });
    return () => {
      live = false;
    };
  }, [base]);

  const title = loaded?.project.name ?? card.slug;
  const ref = loaded?.project.ref ?? card.ref;
  const rev = loaded?.proposed ?? null;
  // Only the project's first run, from planning or active: reopened later
  // (runs done, paused, a newer proposal), the card only opens the project.
  const canStart =
    Boolean(loaded?.project.can_write) &&
    rev != null &&
    (loaded?.project.status === "planning" || loaded?.project.status === "active") &&
    (loaded?.project.runs ?? []).length === 0;

  const start = async () => {
    if (!loaded || rev == null || busy) return;
    setBusy(true);
    setError(null);
    const steps: { path: string; method?: "PATCH"; body: Record<string, unknown> }[] = [
      { path: `${base}/playbook/${rev}/activate`, body: {} },
    ];
    if (loaded.project.status === "planning") {
      steps.push({ path: base, method: "PATCH", body: { status: "active" } });
    }
    steps.push({ path: `${base}/runs`, body: { playbook_rev: rev } });
    try {
      let runNo: number | null = null;
      for (const step of steps) {
        const res = await sendProjectAction<{ run_no?: number }>(step.path, newIdempotencyKey(), {
          method: step.method,
          body: step.body,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        if (step.path.endsWith("/runs")) runNo = res.data?.run_no ?? null;
      }
      setStarted({ runNo });
      setLoaded({ ...loaded, activeRev: rev, proposed: null, project: { ...loaded.project, status: "active" } });
    } finally {
      setBusy(false);
    }
  };

  const status = started
    ? t("chatCard.running", { run: started.runNo ?? 1 })
    : rev != null
      ? t("chatCard.proposed", { rev })
      : loaded?.activeRev != null
        ? t("chatCard.active", { rev: loaded.activeRev })
        : loaded
          ? t("chatCard.noPlaybook")
          : null;

  return (
    <div
      data-component="ProjectChatCard"
      data-slug={card.slug}
      className="mt-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{title}</span>
        {ref ? (
          <span className="rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-muted)]">
            {ref}
          </span>
        ) : null}
        {status ? (
          <span
            data-status={started ? "running" : rev != null ? "proposed" : "settled"}
            className="rounded-[var(--radius-full)] border border-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-accent)]"
          >
            {status}
          </span>
        ) : null}
      </div>
      {missing ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{t("chatCard.unavailable")}</p>
      ) : null}
      {card.quoted ? (
        <p data-component="ProjectChatCardShared" className="mt-1 text-xs text-[var(--color-muted)]">
          {t("chatCard.quoted")}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={projectHref(card.slug, started ? null : rev)}
          data-action="open-project"
          className="inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium hover:bg-[var(--color-surface-2)]"
        >
          {t("chatCard.open")}
        </a>
        {canStart && !started ? (
          <button
            type="button"
            data-action="activate-and-run"
            disabled={busy}
            onClick={() => void start()}
            className="inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {busy ? t("chatCard.starting") : t("chatCard.start", { rev: rev ?? 1 })}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-danger)]">
          {t("chatCard.failed")} {error}
        </p>
      ) : null}
    </div>
  );
}
