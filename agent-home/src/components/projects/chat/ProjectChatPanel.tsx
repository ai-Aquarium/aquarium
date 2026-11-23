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
import { stripInjectedContext } from "@/lib/chat/transcript";
import { useT } from "@/i18n";
import type {
  ChatAttachment,
  ChatMessage,
  ChatSendResult,
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

/** How often the open group chat re-reads the timeline for other members' turns. */
export const TIMELINE_POLL_MS = 5000;

/**
 * The docked project group chat: one timeline every member sees, over each
 * person's own per-profile conversations (their own prompt cache and memory;
 * members' turns run in parallel and land in arrival order). The picker sets
 * who answers the caller's next message; the server puts the project context
 * / catch-up of what the group said at the top of that turn. "Ask agent" off
 * sends a message to the members only. A viewer reads but never posts.
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
  const [busy, setBusy] = useState(false);
  const [askAgent, setAskAgent] = useState(true);
  // A page refresh (a plan saved, discarded or made active) brings a new
  // timeline: take it, so no stale proposal card stays actionable.
  const [seenTimeline, setSeenTimeline] = useState(chat?.timeline);
  if (chat?.timeline !== seenTimeline) {
    setSeenTimeline(chat?.timeline);
    if (chat?.timeline) setTimeline(chat.timeline);
  }
  // What reaches the composer: a tab's "Discuss in chat" text, or the unsent
  // text carried over when the picker swaps the answering profile's pane.
  const [handoff, setHandoff] = useState<ComposerDraft | undefined>(undefined);
  const [seenDraft, setSeenDraft] = useState<number | undefined>(undefined);
  if (composerDraft && composerDraft.seq !== seenDraft) {
    setSeenDraft(composerDraft.seq);
    setHandoff((prev) => ({ text: composerDraft.text, seq: (prev?.seq ?? 0) + 1 }));
  }
  const unsent = useRef("");
  const onComposerText = useCallback((text: string) => {
    unsent.current = text;
  }, []);
  const select = (next: string) => {
    if (next === profile) return;
    const text = unsent.current;
    if (text) setHandoff((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
    setProfile(next);
  };

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
      const next = (await res.json()) as ProjectChatTimeline;
      // An unchanged poll keeps the same object: nothing re-renders.
      setTimeline((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    } catch {
      // Keep the timeline on screen; the next turn re-reads it.
    }
  }, [slug]);

  // Live: other members' turns arrive while the chat is on screen and idle.
  const polling = Boolean(chat?.timeline) && !hidden && !busy;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void refresh(), TIMELINE_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  const picker = (id: string) => (
    <ProjectChatProfilePicker
      id={id}
      profiles={profiles}
      selected={profile}
      disabled={busy}
      onSelect={select}
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
              key={profile}
              slug={slug}
              profile={profile}
              timeline={timeline}
              storageEnabled={chat.storageEnabled}
              hidden={hidden}
              onMessageCount={onMessageCount}
              onBusy={setBusy}
              onStale={refresh}
              composerDraft={handoff}
              onComposerText={onComposerText}
              askAgent={askAgent}
              onAskAgent={setAskAgent}
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
  onComposerText,
  askAgent,
  onAskAgent,
}: {
  askAgent: boolean;
  onAskAgent: (on: boolean) => void;
  slug: string;
  profile: string;
  timeline: ProjectChatTimeline;
  storageEnabled: boolean;
  hidden: boolean;
  onMessageCount: (count: number) => void;
  onBusy: (busy: boolean) => void;
  onStale: () => void;
  composerDraft?: ComposerDraft;
  onComposerText: (text: string) => void;
}) {
  const t = useT("projects");
  const initialMessages = useMemo(() => timelineMessages(timeline), [timeline]);
  // Turns that ended (`stale`) vs the ones re-read (`synced`): the timeline is
  // re-read once nothing is in flight, without remounting the composer.
  const [stale, setStale] = useState(0);
  const [synced, setSynced] = useState(0);
  const conv = useChatConversation({
    profile,
    initialSessionId: sessionFor(timeline, profile),
    initialMessages,
    findSession: () => undefined,
    onSessionsStale: () => setStale((n) => n + 1),
    hidden,
    projectSlug: slug,
    followInitialMessages: true,
  });
  const busy = conv.selBusy;
  const me = timeline.me;
  const canPost = timeline.can_post !== false;
  const myName = timeline.people?.find((p) => p.user_id === me)?.name;
  const note = useProjectAction();
  const [noteError, setNoteError] = useState<string | null>(null);
  // "Ask agent" off: the message goes to the members only, no agent turn.
  const sendToMembers = async (
    text: string,
    attachments: ChatAttachment[],
  ): Promise<ChatSendResult> => {
    setNoteError(null);
    const res = await note.run(`/api/projects/${encodeURIComponent(slug)}/chat/messages`, {
      body: { content: text },
      skipRefresh: true,
    });
    if (!res?.ok) {
      setNoteError(t("dock.chat.memberSendFailed"));
      return false;
    }
    onStaleRef.current();
    return attachments.length ? "attachments_kept" : true;
  };
  const view = askAgent ? conv : { ...conv, send: sendToMembers };

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
  if (stale !== synced && !busy) setSynced(stale);
  useEffect(() => {
    if (synced > 0) onStaleRef.current();
  }, [synced]);

  const count = conv.messages.length;
  const onCountRef = useRef(onMessageCount);
  useEffect(() => {
    onCountRef.current = onMessageCount;
  });
  useEffect(() => onCountRef.current(count), [count]);

  // Live rows (the turn being typed/streamed) have no profile yet: they are
  // the picked profile's, and the caller's own.
  const labelled = (m: ChatMessage) => m.profile ?? profile;
  const personOf = (m: ChatMessage) =>
    m.profile || m.memberOnly ? (m.personName ?? m.person) : (myName ?? me);
  const mine = (m: ChatMessage) => !m.person || m.person === me;
  // A live row gets its catch-up / context marks once the timeline re-read
  // has the stored turn.
  const marksFor = (m: ChatMessage): ChatMessage => {
    if (m.role !== "user" || m.profile || m.sentWhileWorking) return m;
    const typed = stripInjectedContext(m.content);
    const stored = [...timeline.messages]
      .reverse()
      .find(
        (r) =>
          r.role === "user" &&
          r.profile === profile &&
          (!me || r.person === me) &&
          stripInjectedContext(r.content) === typed,
      );
    if (!stored) return m;
    return { ...m, catchUp: stored.catch_up || undefined, seeded: stored.seeded || undefined };
  };
  const cards = useMemo(
    () => placeProposals(conv.messages, timeline.proposals),
    [conv.messages, timeline.proposals],
  );

  const renderAround = (row: ChatMessage, i: number) => {
    const m = marksFor(row);
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
    before.push(
      <TurnLabel
        key="label"
        role={m.role}
        profile={who}
        person={mine(m) ? undefined : personOf(m)}
        memberOnly={m.memberOnly}
      />,
    );
    const after = (cards.get(i) ?? []).map((p) => (
      <ProposedPlaybookCard key={`p${p.rev}`} slug={slug} proposal={p} />
    ));
    return { before, after };
  };

  const missed = missedCount(conv.messages, profile, me);
  const hasSession = sessionFor(timeline, profile) !== null || conv.sessionId !== null;
  const pending = !canPost || busy || !askAgent ? null : missed > 0 ? (
    <Note data-component="ProjectChatCatchUp" tone="accent">
      {t("dock.chat.catchUpNext", { profile, count: missed })}
    </Note>
  ) : !hasSession ? (
    <Note data-component="ProjectChatSeed">{t("dock.chat.seedNext", { profile })}</Note>
  ) : null;

  return (
    <div data-component="ProjectChatPane" className="flex min-h-0 flex-1 flex-col">
      <ChatConversationView
        conv={view}
        readOnly={
          canPost ? undefined : (
            <Note data-component="ProjectChatReadOnly">{t("dock.chat.viewerReadOnly")}</Note>
          )
        }
        storageEnabled={storageEnabled}
        composerLauncherClearance={false}
        composerDraft={composerDraft}
        onComposerTextChange={onComposerText}
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
        aboveComposer={
          canPost ? (
            <div className="space-y-2 pt-2">
              {pending}
              {noteError ? (
                <p role="alert" className="text-xs text-[var(--color-danger)]">
                  {noteError}
                </p>
              ) : null}
              <AskAgentToggle on={askAgent} profile={profile} onChange={onAskAgent} />
            </div>
          ) : null
        }
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

/** "Ask agent": on, the picked profile answers; off, only the members read it. */
export function AskAgentToggle({
  on,
  profile,
  onChange,
}: {
  on: boolean;
  profile: string;
  onChange: (on: boolean) => void;
}) {
  const t = useT("projects");
  return (
    <div data-component="AskAgentToggle" className="flex items-center gap-2 text-xs">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        data-action="ask-agent"
        onClick={() => onChange(!on)}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-[var(--radius-full)] px-1 font-medium text-[var(--color-fg)]"
      >
        <span
          aria-hidden
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-[var(--radius-full)] transition-colors ${
            on ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"
          }`}
        >
          <span
            className={`absolute h-4 w-4 rounded-[var(--radius-full)] bg-[var(--color-surface)] shadow transition-transform ${
              on ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </span>
        {t("dock.chat.askAgent")}
      </button>
      <span className="min-w-0 truncate text-[var(--color-muted)]">
        {on ? t("dock.chat.askAgentOn", { profile }) : t("dock.chat.askAgentOff")}
      </span>
    </div>
  );
}

function TurnLabel({
  role,
  profile,
  person,
  memberOnly,
}: {
  role: string;
  profile: string;
  /** Another member's turn (unset on the caller's own). */
  person?: string;
  memberOnly?: boolean;
}) {
  const t = useT("projects");
  if (role === "user") {
    const text = memberOnly
      ? t("dock.chat.toMembers", { person: person ?? t("dock.chat.you") })
      : person
        ? t("dock.chat.fromTo", { person, profile })
        : t("dock.chat.to", { profile });
    return (
      <p
        data-component="ProjectChatTurnLabel"
        data-profile={memberOnly ? undefined : profile}
        data-person={person}
        className="-mb-1.5 pt-1 text-right text-[11px] text-[var(--color-muted)]"
      >
        {text}
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
      {person ? (
        <span className="font-normal text-[var(--color-muted)]">
          {t("dock.chat.replyFor", { person })}
        </span>
      ) : null}
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
