"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Section, ListBox, EmptyNote } from "@/components/profiles/page/Section";
import { NewSkillModal } from "@/components/skills/NewSkillModal";
import {
  addCandidates,
  librarySourceLabel,
  needsCopyChoice,
  profileSkills,
} from "@/components/skills/library";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import {
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui/Sheet";
import {
  ArrowRightIcon,
  LoaderIcon,
  PlusIcon,
  SparklesIcon,
} from "@/components/ui/icons";
import { errorText, getJson, profilePath, sendJson } from "@/lib/admin-fetch";
import type { SkillUsageRow } from "@/lib/skills/usage";
import { useAction } from "@/lib/use-action";
import type {
  ProfileStats,
  SkillCopyChoice,
  SkillLibrary,
  SkillLibraryEntry,
} from "@/types";

interface Suggestion {
  skill: string;
  score: number;
  reason?: string;
}

interface SuggestionsResponse {
  ok: boolean;
  reason?: string;
  suggestions?: Suggestion[];
  cached?: boolean;
}

/**
 * "What it's good at" — the skills centerpiece: what it actually uses, every
 * skill switched on for it, what it could learn next (scored 1–10 against
 * its goal + soul by the backend), and how to teach it more.
 */
export function SkillsGrowth({
  profile,
  stats,
  library,
  skillUses,
}: {
  profile: string;
  stats: ProfileStats | null;
  library: SkillLibrary | null;
  skillUses: SkillUsageRow[];
}) {
  const [skills, setSkills] = useState<SkillLibrary | null>(library);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copyPick, setCopyPick] = useState<SkillLibraryEntry | null>(null);
  const [teachOpen, setTeachOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestState, setSuggestState] = useState<"loading" | "ready" | "failed">("loading");

  const { on } = useMemo(
    () => (skills ? profileSkills(skills, profile) : { on: [], off: [] }),
    [skills, profile],
  );
  const candidates = useMemo(
    () => (skills ? addCandidates(skills, profile) : []),
    [skills, profile],
  );
  const categories = useMemo(
    () => [...new Set((skills?.skills ?? []).map((s) => s.category).filter(Boolean))].sort(),
    [skills],
  );
  const byName = useMemo(
    () => new Map((skills?.skills ?? []).map((s) => [s.name, s])),
    [skills],
  );

  const reload = async () => {
    try {
      const data = await getJson<SkillLibrary>("/api/skills/library");
      if (data && Array.isArray(data.skills)) setSkills(data);
    } catch {
      /* keep the last good list */
    }
  };

  // LLM-scored "could learn" list; graceful fallback to the plain candidate
  // list when the endpoint isn't deployed yet or has no aux client.
  useEffect(() => {
    let cancelled = false;
    getJson<SuggestionsResponse>(`${profilePath(profile, "skill-suggestions")}`)
      .then((data) => {
        if (cancelled) return;
        if (data.ok && Array.isArray(data.suggestions)) {
          setSuggestions(data.suggestions);
          setSuggestState("ready");
        } else {
          setSuggestState("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setSuggestState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const { run: change, pending } = useAction(
    async (action: "add" | "remove", skill: SkillLibraryEntry, where?: SkillCopyChoice) => {
      setBusy(skill.name);
      setError(null);
      setStatus(null);
      try {
        await sendJson(`/api/skills/library/${action}`, "POST", {
          target: profile,
          name: skill.name,
          ...(where ? { where } : {}),
        });
        setStatus(
          action === "add"
            ? `${skill.name} added — the next new chat can use it.`
            : `${skill.name} turned off — the file stays in the library.`,
        );
        await reload();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(null);
      }
    },
  );

  function add(skill: SkillLibraryEntry) {
    if (needsCopyChoice(skill, profile)) {
      setCopyPick(skill);
      return;
    }
    void change("add", skill);
  }

  const mostUsed = useMemo(() => {
    const rows = skillUses.filter((u) => u.uses > 0).slice(0, 10);
    if (rows.length) return rows;
    // Cold-start: the stats rollup's top_skills (no per-skill rates).
    return (stats?.top_skills ?? [])
      .slice(0, 10)
      .map((s) => ({
        name: s.name,
        uses: s.uses,
        sessions: 0,
        tasks: 0,
        projects: 0,
        success: 0,
        partial: 0,
        failure: 0,
        unknown: 0,
        success_rate: null,
        last_used_at: null,
        trend: [],
      }));
  }, [skillUses, stats]);

  // Scored candidates when the endpoint answered, else the plain "off" list.
  const couldLearn: Array<{ entry: SkillLibraryEntry; score: number | null; reason: string | null }> =
    useMemo(() => {
      if (suggestState === "ready" && suggestions) {
        return suggestions
          .filter((s) => byName.has(s.skill))
          .map((s) => ({ entry: byName.get(s.skill)!, score: s.score, reason: s.reason ?? null }))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      }
      return candidates.map((entry) => ({ entry, score: null, reason: null }));
    }, [suggestState, suggestions, byName, candidates]);

  return (
    <Section
      title={
        <span className="flex items-center gap-1.5">
          <SparklesIcon size={13} /> What it&apos;s good at
        </span>
      }
      hint="Skills are how it learns. Turn on what fits its job, teach it new ones, and watch what it actually uses."
    >
      {error ? <InlineAlert tone="danger" className="mb-2">{error}</InlineAlert> : null}
      {status ? <p className="mb-2 text-xs text-[var(--color-success)]">{status}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Most used */}
        <div>
          <h3 className="mb-1.5 text-xs font-semibold">Most used</h3>
          {mostUsed.length ? (
            <ListBox>
              {mostUsed.map((u) => (
                <li key={u.name} className="flex items-center gap-2 px-3 py-2">
                  <Link
                    data-appmcp-hint="Opens this skill's page"
                    href={`/skills/${encodeURIComponent(u.name)}`}
                    className="min-w-0 flex-1 truncate text-sm font-medium hover:text-[var(--color-accent)]"
                  >
                    {u.name}
                  </Link>
                  {u.success_rate !== null ? (
                    <Pill tone={u.success_rate >= 0.8 ? "success" : u.success_rate >= 0.5 ? "warning" : "danger"}>
                      {Math.round(u.success_rate * 100)}%
                    </Pill>
                  ) : null}
                  <span className="text-xs text-[var(--color-muted)]">{u.uses}×</span>
                </li>
              ))}
            </ListBox>
          ) : (
            <EmptyNote>Nothing used yet — the list fills in as it works.</EmptyNote>
          )}
        </div>

        {/* Teach it */}
        <div>
          <h3 className="mb-1.5 text-xs font-semibold">Teach it</h3>
          <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
            <p className="text-xs text-[var(--color-muted)]">
              Skills come from the shared library, the hub, or a skill it writes itself.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primaryButtonClass} onClick={() => setTeachOpen(true)}>
                <PlusIcon size={12} className="mr-1 inline" /> Teach a new skill
              </button>
              <Link href="/skills?view=hub" className={`${secondaryButtonClass} inline-flex items-center`}>
                Browse the hub <ArrowRightIcon size={12} className="ml-1" />
              </Link>
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              Tip: when a project goes well, open it and choose <em>Save as skill</em> — Hermes turns
              what worked into a reusable skill.
            </p>
          </div>
        </div>
      </div>

      {/* On this agent — the long list */}
      <div className="mt-4">
        <h3 className="mb-1.5 flex items-baseline justify-between text-xs font-semibold">
          On this agent
          <span className="text-[11px] font-normal text-[var(--color-muted)]">
            {on.length} on{candidates.length ? ` · ${candidates.length} more in the library` : ""}
          </span>
        </h3>
        {on.length ? (
          <ListBox>
            {on.map((s) => (
              <SkillRow
                key={s.name}
                skill={s}
                enabled
                busy={busy === s.name || pending}
                onToggle={() => void change("remove", s)}
              />
            ))}
          </ListBox>
        ) : (
          <EmptyNote>No skills switched on — pick from the library below.</EmptyNote>
        )}
      </div>

      {/* Could learn */}
      <div className="mt-4">
        <h3 className="mb-1.5 flex items-baseline justify-between text-xs font-semibold">
          Could learn
          {suggestState === "loading" ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-normal text-[var(--color-muted)]">
              <LoaderIcon size={11} className="animate-spin" /> scoring against its goal & soul…
            </span>
          ) : suggestState === "ready" ? (
            <span className="text-[11px] font-normal text-[var(--color-muted)]">
              scored 1–10 for this agent
            </span>
          ) : null}
        </h3>
        {couldLearn.length ? (
          <ListBox>
            {couldLearn.map(({ entry, score, reason }) => (
              <li key={entry.name} className="flex items-center gap-2 px-3 py-2">
                {score !== null ? (
                  <span
                    aria-label={`relevance ${score} of 10`}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[11px] font-bold ${
                      score >= 8
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                        : score >= 5
                          ? "bg-[var(--color-surface)] text-[var(--color-fg)]"
                          : "bg-[var(--color-surface)] text-[var(--color-muted)]"
                    }`}
                  >
                    {score}
                  </span>
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{entry.name}</span>
                    <Pill tone="muted">{librarySourceLabel(entry)}</Pill>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-[var(--color-muted)]">
                    {reason || entry.description}
                  </p>
                </div>
                <button
                  type="button"
                  data-action="add-skill"
                  data-appmcp-hint={`Adds ${entry.name} to this agent`}
                  className={secondaryButtonClass}
                  disabled={pending || busy === entry.name}
                  onClick={() => add(entry)}
                >
                  {busy === entry.name ? "Adding…" : "Add"}
                </button>
              </li>
            ))}
          </ListBox>
        ) : suggestState === "loading" ? (
          <EmptyNote>Scoring the library…</EmptyNote>
        ) : (
          <EmptyNote>It already has everything in the library.</EmptyNote>
        )}
      </div>

      {copyPick ? (
        <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <p className="text-sm">
            <strong>{copyPick.name}</strong> lives in{" "}
            {copyPick.owners.join(", ") || "another profile"} — copy it where?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-appmcp-hint="Copies the skill into the shared library and adds it"
              className={primaryButtonClass}
              onClick={() => {
                const s = copyPick;
                setCopyPick(null);
                void change("add", s, "shared");
              }}
            >
              Shared library (every agent can use it)
            </button>
            <button
              type="button"
              data-appmcp-hint="Copies the skill only into this agent"
              className={secondaryButtonClass}
              onClick={() => {
                const s = copyPick;
                setCopyPick(null);
                void change("add", s, "only");
              }}
            >
              Only {profile}
            </button>
            <button type="button" data-appmcp-hint="Cancels adding this skill" className={secondaryButtonClass} onClick={() => setCopyPick(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {teachOpen ? (
        <NewSkillModal
          profile={profile}
          categories={categories}
          onClose={() => setTeachOpen(false)}
          onCreated={async () => {
            setTeachOpen(false);
            await reload();
          }}
        />
      ) : null}
    </Section>
  );
}

function SkillRow({
  skill,
  enabled,
  busy,
  onToggle,
}: {
  skill: SkillLibraryEntry;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            data-appmcp-hint="Opens this skill's page"
            href={`/skills/${encodeURIComponent(skill.name)}`}
            className={`font-medium hover:text-[var(--color-accent)] ${enabled ? "" : "text-[var(--color-muted)]"}`}
          >
            {skill.name}
          </Link>
          <Pill tone="muted">{librarySourceLabel(skill)}</Pill>
        </div>
        <p className="mt-0.5 line-clamp-1 text-xs text-[var(--color-muted)]">{skill.description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${skill.name} ${enabled ? "on" : "off"}`}
        data-appmcp-hint={`Turns ${skill.name} ${enabled ? "off" : "on"} for this agent`}
        disabled={busy}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            enabled ? "left-4.5 translate-x-0" : "left-0.5"
          }`}
          style={enabled ? { left: "1.125rem" } : { left: "0.125rem" }}
        />
      </button>
    </li>
  );
}
