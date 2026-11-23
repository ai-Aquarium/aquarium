"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ChatConversationView } from "@/components/chat/ChatConversationView";
import type { ComposerDraft } from "@/components/chat/Composer";
import { useChatConversation } from "@/components/chat/useChatConversation";
import { ProjectChatDock } from "@/components/projects/chat/ProjectChatDock";
import type { DockAction, DockState } from "@/components/projects/chat/dockState";
import {
  missedCount,
  pickerProfiles,
  placeProposals,
  sessionFor,
  timelineMessages,
} from "@/components/projects/chat/projectTimeline";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useT } from "@/i18n";
import type {
  ChatMessage,
  ProfileSummary,
  ProjectChatProposal,
  ProjectChatTimeline,
} from "@/types";

/** What the project chat opens with (read by the page). */
export interface ProjectChatData {
  /** Who answers first: the last profile that did, else the session's. */
  profile: string;
  storageEnabled: boolean;
  /** Profiles the caller may chat in (their active enrolments). */
  profiles: ProfileSummary[];
  /** Profiles on the project. */
  projectProfiles: string[];
  /** Null when the timeline couldn't be read (the dock says so). */
  timeline: ProjectChatTimeline | null;
}

/**
 * The docked project chat (2026-11-22 plan, stage 2): one timeline over the
 * per-profile conversations. Each profile keeps its own conversation (its own
 * prompt cache and memory); the picker sets who answers the next message, and
 * the server puts the project context / catch-up at the top of that turn.
 */
export function ProjectChatPanel({
  slug,
  chat,
  state,
  dispatch,
  phoneOpen,
  hidden,
  composerDraft,
}: {
  slug: string;
  chat: ProjectChatData | null;
  state: DockState;
  dispatch: (action: DockAction) => void;
  phoneOpen: boolean;
  /** Off screen (minimized dock, another phone tab). */
  hidden: boolean;
  /** Text a tab hands to the composer ("Discuss in chat"). */
  composerDraft?: ComposerDraft;
}) {
  const t = useT("projects");
  const [profile, setProfile] = useState(chat?.profile ?? "default");
  const [timeline, setTimeline] = useState(chat?.timeline ?? null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  // A handed-over draft fills the composer once; the pane remounts after each
  // turn, and a sent draft must not come back.
  const [spentDraft, setSpentDraft] = useState<number | undefined>(undefined);
  const draftSeq = useRef(composerDraft?.seq);
  useEffect(() => {
    draftSeq.current = composerDraft?.seq;
  });

  const profiles = useMemo(
    () => (chat ? pickerProfiles(chat.profiles, chat.projectProfiles, profile) : []),
    [chat, profile],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/chat/timeline`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      setTimeline((await res.json()) as ProjectChatTimeline);
      setSpentDraft(draftSeq.current);
      setVersion((v) => v + 1);
    } catch {
      // Keep the timeline on screen; the next turn re-reads it.
    }
  }, [slug]);

  const picker = (id: string) => (
    <ProjectChatProfilePicker
      id={id}
      profiles={profiles}
      selected={profile}
      disabled={busy}
      onSelect={setProfile}
    />
  );

  return (
    <ProjectChatDock
      state={state}
      dispatch={dispatch}
      profile={profile}
      phoneOpen={phoneOpen}
      controls={chat ? picker("project-chat-profile") : undefined}
    >
      {(onMessageCount) =>
        chat && timeline ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="pb-2 lg:hidden">{picker("project-chat-profile-phone")}</div>
            <ProjectChatPane
              key={`${profile}:${version}`}
              slug={slug}
              profile={profile}
              timeline={timeline}
              storageEnabled={chat.storageEnabled}
              hidden={hidden}
              onMessageCount={onMessageCount}
              onBusy={setBusy}
              onStale={refresh}
              composerDraft={
                composerDraft && composerDraft.seq !== spentDraft ? composerDraft : undefined
              }
            />
          </div>
        ) : (
          <p className="p-3 text-sm text-[var(--color-muted)]">{t("dock.unavailable")}</p>
        )
      }
    </ProjectChatDock>
  );
}

/** The header picker: who answers the next message. */
export function ProjectChatProfilePicker({
  id,
  profiles,
  selected,
  disabled,
  onSelect,
}: {
  id: string;
  profiles: ProfileSummary[];
  selected: string;
  disabled: boolean;
  onSelect: (profile: string) => void;
}) {
  const t = useT("projects");
  const active = profiles.find((p) => p.name === selected);
  return (
    <div data-component="ProjectChatProfilePicker" className="flex min-w-0 items-center gap-2 text-xs">
      <label htmlFor={id} className="shrink-0 text-[var(--color-muted)]">
        {t("dock.chat.picker")}
      </label>
      <select
        id={id}
        value={selected}
        disabled={disabled || profiles.length < 2}
        aria-label={t("dock.chat.pickerAria")}
        title={disabled ? t("dock.chat.switchBusy") : active?.description || undefined}
        onChange={(e) => onSelect(e.target.value)}
        className="min-h-[44px] min-w-0 max-w-[12rem] flex-1 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] disabled:opacity-60 lg:min-h-[32px]"
      >
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      {active?.description ? (
        <span className="hidden min-w-0 truncate text-[var(--color-muted)] xl:block">
          {active.description}
        </span>
      ) : null}
    </div>
  );
}

function ProjectChatPane({
  slug,
  profile,
  timeline,
  storageEnabled,
  hidden,
  onMessageCount,
  onBusy,
  onStale,
  composerDraft,
}: {
  slug: string;
  profile: string;
  timeline: ProjectChatTimeline;
  storageEnabled: boolean;
  hidden: boolean;
  onMessageCount: (count: number) => void;
  onBusy: (busy: boolean) => void;
  onStale: () => void;
  composerDraft?: ComposerDraft;
}) {
  const t = useT("projects");
  const initialMessages = useMemo(() => timelineMessages(timeline), [timeline]);
  const [stale, setStale] = useState(false);
  const conv = useChatConversation({
    profile,
    initialSessionId: sessionFor(timeline, profile),
    initialMessages,
    findSession: () => undefined,
    onSessionsStale: () => setStale(true),
    hidden,
    projectSlug: slug,
  });
  const busy = conv.selBusy;

  const onBusyRef = useRef(onBusy);
  useEffect(() => {
    onBusyRef.current = onBusy;
  });
  useEffect(() => onBusyRef.current(busy), [busy]);

  // A turn ended: re-read the merged timeline (ids, catch-up marks, any
  // proposal it saved) once nothing is in flight.
  const onStaleRef = useRef(onStale);
  useEffect(() => {
    onStaleRef.current = onStale;
  });
  useEffect(() => {
    if (stale && !busy) onStaleRef.current();
  }, [stale, busy]);

  const count = conv.messages.length;
  const onCountRef = useRef(onMessageCount);
  useEffect(() => {
    onCountRef.current = onMessageCount;
  });
  useEffect(() => onCountRef.current(count), [count]);

  // Live rows (the turn being typed/streamed) have no profile yet: they are
  // the picked profile's.
  const labelled = (m: ChatMessage) => m.profile ?? profile;
  const cards = useMemo(
    () => placeProposals(conv.messages, timeline.proposals),
    [conv.messages, timeline.proposals],
  );

  const renderAround = (m: ChatMessage, i: number) => {
    const who = labelled(m);
    const before: ReactNode[] = [];
    if (i === 0) {
      if (timeline.truncated) before.push(<Note key="older">{t("dock.chat.olderHidden")}</Note>);
      for (const p of cards.get(-1) ?? []) {
        before.push(<ProposedPlaybookCard key={`p${p.rev}`} slug={slug} proposal={p} />);
      }
    }
    if (m.role === "user" && m.catchUp) {
      before.push(
        <Note key="catch">{t("dock.chat.caughtUp", { profile: who, count: m.catchUp })}</Note>,
      );
    } else if (m.role === "user" && m.seeded) {
      before.push(<Note key="seed">{t("dock.chat.seeded", { profile: who })}</Note>);
    }
    before.push(<TurnLabel key="label" role={m.role} profile={who} />);
    const after = (cards.get(i) ?? []).map((p) => (
      <ProposedPlaybookCard key={`p${p.rev}`} slug={slug} proposal={p} />
    ));
    return { before, after };
  };

  const missed = missedCount(conv.messages, profile);
  const hasSession = sessionFor(timeline, profile) !== null || conv.sessionId !== null;
  const pending = busy ? null : missed > 0 ? (
    <Note data-component="ProjectChatCatchUp" tone="accent">
      {t("dock.chat.catchUpNext", { profile, count: missed })}
    </Note>
  ) : !hasSession ? (
    <Note data-component="ProjectChatSeed">{t("dock.chat.seedNext", { profile })}</Note>
  ) : null;

  return (
    <div data-component="ProjectChatPane" className="flex min-h-0 flex-1 flex-col">
      <ChatConversationView
        conv={conv}
        storageEnabled={storageEnabled}
        composerLauncherClearance={false}
        composerDraft={composerDraft}
        renderAround={renderAround}
        emptyState={
          <div className="space-y-3">
            {(cards.get(-1) ?? []).map((p) => (
              <ProposedPlaybookCard key={`p${p.rev}`} slug={slug} proposal={p} />
            ))}
            <p className="py-8 text-center text-sm text-[var(--color-muted)]">
              {t("dock.chat.empty")}
            </p>
          </div>
        }
        aboveComposer={pending ? <div className="pt-2">{pending}</div> : null}
      />
    </div>
  );
}

function Note({
  children,
  tone = "muted",
  ...rest
}: {
  children: ReactNode;
  tone?: "muted" | "accent";
  "data-component"?: string;
}) {
  return (
    <p
      data-component={rest["data-component"] ?? "ProjectChatNote"}
      className={`flex items-start justify-center gap-1.5 px-2 text-center text-xs ${
        tone === "accent" ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"
      }`}
    >
      <InfoIcon />
      <span>{children}</span>
    </p>
  );
}

function TurnLabel({ role, profile }: { role: string; profile: string }) {
  const t = useT("projects");
  if (role === "user") {
    return (
      <p
        data-component="ProjectChatTurnLabel"
        data-profile={profile}
        className="-mb-1.5 pt-1 text-right text-[11px] text-[var(--color-muted)]"
      >
        {t("dock.chat.to", { profile })}
      </p>
    );
  }
  return (
    <p
      data-component="ProjectChatTurnLabel"
      data-profile={profile}
      className="-mb-1.5 flex items-center gap-1.5 pt-1 text-[11px] font-semibold text-[var(--color-fg)]"
    >
      <span
        aria-hidden
        className="inline-flex h-4 w-4 items-center justify-center rounded-[var(--radius-full)] bg-[var(--color-accent)] text-[9px] text-[var(--color-accent-fg)]"
      >
        {(profile.trim()[0] ?? "?").toUpperCase()}
      </span>
      {profile}
    </p>
  );
}

/** The inline "Playbook vN · Proposed" card a turn that saved a revision shows. */
export function ProposedPlaybookCard({
  slug,
  proposal,
}: {
  slug: string;
  proposal: ProjectChatProposal;
}) {
  const t = useT("projects");
  const action = useProjectAction();
  const parts: string[] = [];
  if (proposal.added) {
    const titles = proposal.added_titles.length ? ` (${proposal.added_titles.join(", ")})` : "";
    parts.push(`${t("dock.chat.proposal.added", { count: proposal.added })}${titles}`);
  }
  if (proposal.changed) parts.push(t("dock.chat.proposal.changed", { count: proposal.changed }));
  if (proposal.removed) parts.push(t("dock.chat.proposal.removed", { count: proposal.removed }));
  const activate = () =>
    void action.run(
      `/api/projects/${encodeURIComponent(slug)}/playbook/${proposal.rev}/activate`,
      { body: {} },
    );
  return (
    <div
      data-component="ProposedPlaybookCard"
      data-rev={proposal.rev}
      className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <PlaybookIcon />
        <span className="font-semibold">{t("dock.chat.proposal.title", { rev: proposal.rev })}</span>
        <span
          className={`rounded-[var(--radius-full)] px-2 py-0.5 text-[11px] font-medium ${
            proposal.active
              ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
              : "border border-[var(--color-accent)] text-[var(--color-accent)]"
          }`}
        >
          {proposal.active ? t("dock.chat.proposal.active") : t("dock.chat.proposal.proposed")}
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {parts.length ? parts.join(" · ") : t("dock.chat.proposal.noChange")}
        {proposal.created_by ? ` · ${t("dock.chat.proposal.by", { who: proposal.created_by })}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={`/projects/${encodeURIComponent(slug)}?tab=plan&rev=${proposal.rev}`}
          data-action="review-proposal"
          className="inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium hover:bg-[var(--color-surface-2)]"
        >
          {t("dock.chat.proposal.review")}
        </a>
        {proposal.active ? null : (
          <button
            type="button"
            data-action="activate-proposal"
            disabled={action.busy}
            onClick={activate}
            className="inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {action.busy ? t("dock.chat.proposal.activating") : t("dock.chat.proposal.activate")}
          </button>
        )}
      </div>
      {action.error ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-danger)]">
          {t("dock.chat.proposal.failed")} {action.error}
        </p>
      ) : null}
    </div>
  );
}

function InfoIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="mt-px h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75v.01" strokeLinecap="round" />
    </svg>
  );
}

function PlaybookIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-[var(--color-accent)]" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3.5 2.75h7l2 2v8.5h-9z" strokeLinejoin="round" />
      <path d="M5.75 7h4.5M5.75 9.5h4.5M5.75 12h2.5" strokeLinecap="round" />
    </svg>
  );
}
