"use client";

import Link from "next/link";
import { useState } from "react";

import { Section, ListBox, EmptyNote } from "@/components/profiles/page/Section";
import { Pill } from "@/components/ui/Pill";
import { timeAgo } from "@/lib/skills/versions";
import type { SkillUsageRow } from "@/lib/skills/usage";
import type { CronJob, Project, SessionSummary } from "@/types";

const TABS = [
  { id: "chats", label: "Chats" },
  { id: "projects", label: "Projects" },
  { id: "cron", label: "Scheduled jobs" },
  { id: "skills", label: "Skill uses" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * "What it's been doing" — the history: recent chats, the projects it ran or
 * is running, its scheduled jobs, and every skill it has fired lately.
 */
export function HistoryTabs({
  sessions,
  projects,
  cronJobs,
  skillUses,
}: {
  sessions: SessionSummary[];
  projects: Project[];
  cronJobs: CronJob[];
  skillUses: SkillUsageRow[];
}) {
  const [tab, setTab] = useState<TabId>("chats");

  return (
    <Section
      title="What it's been doing"
      action={
        <div role="tablist" aria-label="History" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              data-appmcp-hint={`Shows the ${t.label} history`}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                tab === t.id
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {tab === "chats" ? <ChatsTab sessions={sessions} /> : null}
      {tab === "projects" ? <ProjectsTab projects={projects} /> : null}
      {tab === "cron" ? <CronTab jobs={cronJobs} /> : null}
      {tab === "skills" ? <SkillUsesTab rows={skillUses} /> : null}
    </Section>
  );
}

function ChatsTab({ sessions }: { sessions: SessionSummary[] }) {
  if (!sessions.length) {
    return <EmptyNote>No chats yet — say hi on the home page.</EmptyNote>;
  }
  return (
    <ListBox>
      {sessions.map((s) => (
        <li key={s.id}>
          <Link
            href={`/chat?session=${encodeURIComponent(s.id)}`}
            className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-surface)]"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {s.title || s.preview || s.ref || s.id}
              </p>
              <p className="truncate text-xs text-[var(--color-muted)]">
                {s.message_count} messages{s.source ? ` · ${s.source}` : ""}
              </p>
            </div>
            {s.is_active ? <Pill tone="accent">live</Pill> : null}
            <span className="shrink-0 text-xs text-[var(--color-muted)]">
              {s.last_active ? timeAgo(s.last_active) : ""}
            </span>
          </Link>
        </li>
      ))}
    </ListBox>
  );
}

const PROJECT_TONE: Record<string, "success" | "accent" | "muted" | "warning" | "danger"> = {
  done: "success",
  active: "accent",
  running: "accent",
  paused: "warning",
};

function ProjectsTab({ projects }: { projects: Project[] }) {
  if (!projects.length) {
    return <EmptyNote>No projects run on this agent yet.</EmptyNote>;
  }
  return (
    <ListBox>
      {projects.map((p) => (
        <li key={p.slug}>
          <Link
            data-appmcp-hint="Opens this project"
            href={`/projects/${encodeURIComponent(p.slug)}`}
            className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-surface)]"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
            <Pill tone={PROJECT_TONE[p.status] ?? "muted"}>{p.status}</Pill>
          </Link>
        </li>
      ))}
    </ListBox>
  );
}

/** "in 5 min" / "in 3h" / a date for a next-run timestamp; "now" when due. */
function inFuture(when: number, now = Date.now()): string {
  const secs = Math.round(when - now / 1000);
  if (secs <= 0) return "now";
  if (secs < 3600) return `in ${Math.max(1, Math.floor(secs / 60))} min`;
  if (secs < 86_400) return `in ${Math.floor(secs / 3600)}h`;
  const date = new Date(when * 1000);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function CronTab({ jobs }: { jobs: CronJob[] }) {
  if (!jobs.length) {
    return <EmptyNote>No scheduled jobs — it only works when you ask.</EmptyNote>;
  }
  return (
    <ListBox>
      {jobs.map((j, i) => (
        <li key={j.id ?? j.name ?? i} className="flex items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{j.name || j.id || "Scheduled job"}</p>
            {typeof j.next_run_at === "number" && j.next_run_at ? (
              <p className="text-xs text-[var(--color-muted)]">
                next run {inFuture(j.next_run_at)}
              </p>
            ) : null}
          </div>
          <Pill tone={j.enabled === false ? "muted" : "success"}>
            {j.enabled === false ? "off" : "on"}
          </Pill>
        </li>
      ))}
    </ListBox>
  );
}

function SkillUsesTab({ rows }: { rows: SkillUsageRow[] }) {
  const used = rows.filter((r) => r.uses > 0);
  if (!used.length) {
    return <EmptyNote>No skill uses recorded in the window.</EmptyNote>;
  }
  return (
    <ListBox>
      {used.map((r) => (
        <li key={r.name} className="flex items-center gap-2 px-3 py-2">
          <Link
            data-appmcp-hint="Opens this skill's page"
            href={`/skills/${encodeURIComponent(r.name)}`}
            className="min-w-0 flex-1 truncate text-sm font-medium hover:text-[var(--color-accent)]"
          >
            {r.name}
          </Link>
          {r.success_rate !== null ? (
            <Pill tone={r.success_rate >= 0.8 ? "success" : r.success_rate >= 0.5 ? "warning" : "danger"}>
              {Math.round(r.success_rate * 100)}%
            </Pill>
          ) : null}
          <span className="shrink-0 text-xs text-[var(--color-muted)]">
            {r.uses}×{r.last_used_at ? ` · ${timeAgo(r.last_used_at)}` : ""}
          </span>
        </li>
      ))}
    </ListBox>
  );
}
