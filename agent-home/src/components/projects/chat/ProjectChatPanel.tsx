"use client";

import { MediaProjectContext } from "@/components/chat/MediaProject";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ChatConversationView } from "@/components/chat/ChatConversationView";
import { ComposerPrefillContext, useComposerPrefill } from "@/components/chat/composerPrefill";
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
import { planDiff } from "@/components/projects/changes/planDiff";
import { stripInjectedContext } from "@/lib/chat/transcript";
import { useT } from "@/i18n";
import type {
  ChatAttachment,
  ChatMessage,
  ChatSendResult,
  ProfileSummary,
  ProjectChatProposal,
  ProjectChatSeed,
  ProjectChatTimeline,
  ProjectPlaybookResponse,
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
 * What the agent co-author panel shows about the step it sits on (mockup
 * "Agent co-author panel"): the step label, how much of the project the
 * agent can see, and the suggestions that fit this step.
 */
export interface CoAuthorContext {
  /** "Requirements v5" · "Plan v3" · "Cards" · "Runs · R7". */
  label: string;
  /** The step name alone ("requirements") for the empty-state heading. */
  stepName: string;
  /** "Sees N items". */
  seesCount: number;
  /** "What I can see" rows for the empty state. */
  seesList: string[];
  /** Step-matched suggestion prompts ("Turn my notes into requirements"). */
  suggestions: string[];
}

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
  context,
  needsYou,
  playbook,
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
  /** The step the panel sits on (co-author strip + suggestions). */
  context?: CoAuthorContext;
  /** Proposals + approvals waiting on the person (rail badge). */
  needsYou?: number;
  /** For proposal diff lines (no extra fetch). */
  playbook?: ProjectPlaybookResponse | null;
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
    setHandoff((prev) => ({ text: composerDraft.text, seq: (prev?.seq ?? 0) + 1, append: true }));
  }
  const unsent = useRef("");
  const onComposerText = useCallback((text: string) => {
    unsent.current = text;
  }, []);
  const select = (next: string) => {
    if (next === profile) return;
    // Always hand over (even nothing): the new pane must not replay an old,
    // already-sent handoff.
    const text = unsent.current;
    setHandoff((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
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

  const prefill = useCallback(
    (text: string) => setHandoff((prev) => ({ text, seq: (prev?.seq ?? 0) + 1, append: true })),
    [],
  );

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
      needsYou={needsYou}
      controls={chat ? picker("project-chat-profile") : undefined}
    >
      {(onMessageCount) =>
        chat && timeline ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="pb-2 lg:hidden">{picker("project-chat-profile-phone")}</div>
            <ComposerPrefillContext.Provider value={prefill}>
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
              context={context}
              playbook={playbook}
            />
            </ComposerPrefillContext.Provider>
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
  context,
  playbook,
}: {
  askAgent: boolean;
  onAskAgent: (on: boolean) => void;
  context?: CoAuthorContext;
  playbook?: ProjectPlaybookResponse | null;
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
  const prefill = useComposerPrefill();
  const myName = timeline.people?.find((p) => p.user_id === me)?.name;
  const note = useProjectAction();
  const [noteError, setNoteError] = useState<string | null>(null);
  // "Ask agent" off: the message goes to the members only, no agent turn.
  const sendToMembers = async (
    text: string,
    attachments: ChatAttachment[],
  ): Promise<ChatSendResult> => {
    setNoteError(null);
    if (attachments.length) {
      setNoteError(t("dock.chat.memberNoFiles"));
      return false;
    }
    const res = await note.run(`/api/projects/${encodeURIComponent(slug)}/chat/messages`, {
      body: { content: text },
      skipRefresh: true,
    });
    if (!res?.ok) {
      setNoteError(t("dock.chat.memberSendFailed"));
      return false;
    }
    onStaleRef.current();
    return true;
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

  // Follows-you (mockup state 4): a divider note when the person changes
  // step while the thread stays; cleared once they send again.
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const [lastLabel, setLastLabel] = useState(context?.label);
  if (context?.label !== lastLabel) {
    setLastLabel(context?.label);
    if (context?.label && conv.messages.length > 0) setMovedTo(context.label);
  }
  const sendWrap = useCallback(
    (text: string, attachments: ChatAttachment[]) => {
      setMovedTo(null);
      return view.send(text, attachments);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view],
  );
  const convView = useMemo(
    () => ({ ...view, send: sendWrap }),
    [view, sendWrap],
  );

  const progress = useMemo(() => {
    const note = [...timeline.messages]
      .reverse()
      .find((m) => m.kind === "agent_progress" && m.meta?.items?.length);
    return note?.meta?.items ?? null;
  }, [timeline.messages]);

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
        before.push(
          <ProposedPlaybookCard key={`p${p.rev}`} slug={slug} proposal={p} playbook={playbook} />,
        );
      }
    }
    if (m.role === "user" && m.catchUp) {
      before.push(
        <Note key="catch">{t("dock.chat.caughtUp", { profile: who, count: m.catchUp })}</Note>,
      );
    } else if (m.role === "user" && m.seeded) {
      before.push(<Note key="seed">{t("dock.chat.seeded", { profile: who })}</Note>);
    }
    if (m.seedNote) {
      before.push(
        <SeedNote key="seed-note" person={personOf(m) ?? t("dock.chat.you")} seed={m.seedNote} />,
      );
    } else before.push(
      <TurnLabel
        key="label"
        role={m.role}
        profile={who}
        person={mine(m) ? undefined : personOf(m)}
        memberOnly={m.memberOnly}
        privateHistory={m.privateHistory}
      />,
    );
    const after = (cards.get(i) ?? []).map((p) => (
      <ProposedPlaybookCard key={`p${p.rev}`} slug={slug} proposal={p} playbook={playbook} />
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
    <MediaProjectContext.Provider value={slug}>
    <ComposerPrefillContext.Provider value={canPost ? prefill : null}>
    <div data-component="ProjectChatPane" className="flex min-h-0 flex-1 flex-col">
      {progress ? (
        <div
          data-component="AgentProgressCard"
          className="mx-1 mb-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
        >
          {progress.map((item) => (
            <p key={item.task} className="flex items-center gap-2 py-0.5 text-xs">
              <span aria-hidden className={
                item.state === "done"
                  ? "text-[var(--color-success)]"
                  : item.state === "working"
                    ? "text-[var(--color-accent)]"
                    : "text-[var(--color-muted)]"
              }>
                {item.state === "done" ? "✓" : item.state === "working" ? "◌" : "○"}
              </span>
              <span className={item.state === "todo" ? "text-[var(--color-muted)]" : ""}>
                {item.task}
              </span>
            </p>
          ))}
        </div>
      ) : null}
      {context ? (
        <p
          data-component="CoAuthorStrip"
          className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-1 pb-2 text-xs text-[var(--color-muted)]"
        >
          <span>
            {t("dock.chat.workingOn")}{" "}
            <span className="font-semibold text-[var(--color-fg)]">{context.label}</span>
          </span>
          <span>{t("dock.chat.seesItems", { count: context.seesCount })}</span>
        </p>
      ) : null}
      <ChatConversationView
        conv={convView}
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
        isFromOther={(m) => m.role === "user" && !mine(m)}
        emptyState={
          <div className="space-y-3">
            {(cards.get(-1) ?? []).map((p) => (
              <ProposedPlaybookCard key={`p${p.rev}`} slug={slug} proposal={p} playbook={playbook} />
            ))}
            {context ? (
              <div data-component="CoAuthorEmpty" className="space-y-3 py-4">
                <p className="text-center text-sm font-semibold">
                  {t("dock.chat.coWrite", { step: context.stepName })}
                </p>
                <p className="text-center text-xs text-[var(--color-muted)]">
                  {t("dock.chat.coWriteSub")}
                </p>
                <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                  {t("dock.chat.try")}
                </p>
                <div className="flex flex-col gap-1.5">
                  {context.suggestions.map((sug) => (
                    <button
                      key={sug}
                      type="button"
                      onClick={() => prefill?.(sug)}
                      data-appmcp-hint="Use this suggestion as your message"
                      className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)]"
                    >
                      {sug}
                      <span aria-hidden className="text-[var(--color-muted)]">→</span>
                    </button>
                  ))}
                </div>
                <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                  {t("dock.chat.whatICanSee")}
                </p>
                <ul className="space-y-1 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted)]">
                  {context.seesList.map((item) => (
                    <li key={item} className="flex items-center gap-1.5">
                      <span aria-hidden className="text-[var(--color-accent)]">•</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-[var(--color-muted)]">
                {t("dock.chat.empty")}
              </p>
            )}
          </div>
        }
        aboveComposer={
          canPost ? (
            <div className="space-y-2 pt-2">
              {movedTo ? (
                <Note data-component="CoAuthorMoved">
                  {t("dock.chat.movedTo", { to: movedTo })}
                </Note>
              ) : null}
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
    </ComposerPrefillContext.Provider>
    </MediaProjectContext.Provider>
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
      <span className="min-w-0 text-[var(--color-muted)]">
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
  privateHistory,
}: {
  role: string;
  profile: string;
  /** Another member's turn (unset on the caller's own). */
  person?: string;
  memberOnly?: boolean;
  /** The owner's project chat from before the group chat. */
  privateHistory?: boolean;
}) {
  const t = useT("projects");
  if (role === "user") {
    const text = privateHistory
      ? t("dock.chat.privateTo", { profile })
      : memberOnly
      ? t("dock.chat.toMembers", { person: person ?? t("dock.chat.you") })
      : person
        ? t("dock.chat.fromTo", { person, profile })
        : t("dock.chat.to", { profile });
    return (
      <p
        data-component="ProjectChatTurnLabel"
        data-profile={memberOnly ? undefined : profile}
        data-person={person}
        className={`-mb-1.5 pt-1 text-[11px] text-[var(--color-muted)] ${person ? "text-left" : "text-right"}`}
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

/**
 * How a project started from a private chat opens: the agent's summary and
 * the creator's own request, quoted as typed. Only the creator gets the link
 * back to the private chat (the API sends it to nobody else).
 */
export function SeedNote({ person, seed }: { person: string; seed: ProjectChatSeed }) {
  const t = useT("projects");
  return (
    <section
      data-component="ProjectChatSeedNote"
      className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
    >
      <p className="text-xs font-semibold text-[var(--color-fg)]">
        {t("dock.chat.seed.title", { person })}
      </p>
      {seed.summary ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{seed.summary}</p>
      ) : null}
      <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {t("dock.chat.seed.request", { person })}
      </p>
      <div className="mt-1 space-y-1.5">
        {seed.quotes.map((q, i) => (
          <blockquote
            key={i}
            data-component="ProjectChatSeedQuote"
            className="whitespace-pre-wrap break-words border-l-2 border-[var(--color-accent)] pl-2 text-[var(--color-fg)]"
          >
            {q.text}
          </blockquote>
        ))}
      </div>
      {seed.origin ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          <a
            href={seed.origin.url}
            data-action="open-original-chat"
            className="inline-flex min-h-[44px] items-center font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            {t("dock.chat.seed.openOriginal")}
            {seed.origin.ref ? ` (${seed.origin.ref})` : ""}
          </a>
          <span> · {t("dock.chat.seed.onlyYou")}</span>
        </p>
      ) : null}
    </section>
  );
}

/** The inline "Playbook vN · Proposed" card a turn that saved a revision shows. */
export function ProposedPlaybookCard({
  slug,
  proposal,
  playbook,
}: {
  slug: string;
  proposal: ProjectChatProposal;
  /** For the before/after step lines (mockup state 3 · Proposal). */
  playbook?: ProjectPlaybookResponse | null;
}) {
  const t = useT("projects");
  const action = useProjectAction();
  const discard = useProjectAction();
  const parts: string[] = [];
  if (proposal.added) {
    const titles = proposal.added_titles.length ? ` (${proposal.added_titles.join(", ")})` : "";
    parts.push(`${t("dock.chat.proposal.added", { count: proposal.added })}${titles}`);
  }
  if (proposal.changed) parts.push(t("dock.chat.proposal.changed", { count: proposal.changed }));
  if (proposal.removed) parts.push(t("dock.chat.proposal.removed", { count: proposal.removed }));

  const diff = useMemo(() => {
    if (!playbook) return null;
    const draft = playbook.revisions.find((r) => r.rev === proposal.rev);
    if (!draft) return null;
    const base =
      (proposal.base_rev != null
        ? playbook.revisions.find((r) => r.rev === proposal.base_rev)
        : null) ?? playbook.active;
    if (!base) return null;
    return planDiff(base.steps ?? [], draft.steps ?? []);
  }, [playbook, proposal.rev, proposal.base_rev]);
  const diffRows = (diff?.rows ?? []).filter((r) => r.kind !== "same").slice(0, 3);
  const unchanged = diff ? diff.rows.length - diffRows.length - 0 : 0;
  const sameCount = diff ? diff.rows.filter((r) => r.kind === "same").length : 0;

  const activate = () =>
    void action.run(
      `/api/projects/${encodeURIComponent(slug)}/playbook/${proposal.rev}/activate`,
      { body: {} },
    );
  const onDiscard = () =>
    void discard.run(
      `/api/projects/${encodeURIComponent(slug)}/playbook/${proposal.rev}`,
      { method: "DELETE" },
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
        {proposal.base_rev != null ? (
          <span className="rounded-[var(--radius-full)] border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-medium">
            v{proposal.base_rev} → v{proposal.rev}
          </span>
        ) : null}
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
      {diffRows.length ? (
        <div data-component="ProposalDiff" className="mt-2 space-y-1.5">
          {diffRows.map((row) => (
            <div key={row.key} className="text-xs">
              <p className="font-medium">{row.step.title}</p>
              {row.before?.body && row.kind === "changed" ? (
                <p className="rounded bg-[var(--color-danger)]/10 px-2 py-0.5 text-[var(--color-danger)] line-through">
                  {row.before.body}
                </p>
              ) : null}
              {row.kind === "removed" ? (
                <p className="rounded bg-[var(--color-danger)]/10 px-2 py-0.5 text-[var(--color-danger)] line-through">
                  {row.step.body ?? row.step.title}
                </p>
              ) : row.step.body ? (
                <p className="rounded bg-[var(--color-success)]/10 px-2 py-0.5 text-[var(--color-success)]">
                  {row.step.body}
                </p>
              ) : null}
            </div>
          ))}
          <p className="text-[11px] text-[var(--color-muted)]">
            {t("dock.chat.proposal.unchanged", { count: sameCount + Math.max(0, unchanged - sameCount) })}
          </p>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {proposal.active ? null : (
          <button
            type="button"
            data-action="activate-proposal"
            disabled={action.busy}
            onClick={activate}
            className="inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {action.busy
              ? t("dock.chat.proposal.activating")
              : t("dock.chat.proposal.saveAs", { rev: proposal.rev })}
          </button>
        )}
        <a
          href={`/projects/${encodeURIComponent(slug)}?tab=plan&rev=${proposal.rev}`}
          data-action="review-proposal"
          data-appmcp-hint="Open this proposal in the plan step to adjust before saving"
          className="inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium hover:bg-[var(--color-surface-2)]"
        >
          {t("dock.chat.proposal.editFirst")}
        </a>
        {proposal.active ? null : (
          <button
            type="button"
            data-action="discard-proposal"
            disabled={discard.busy}
            onClick={onDiscard}
            className="inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-muted)] disabled:opacity-60"
          >
            {discard.busy ? t("dock.chat.proposal.discarding") : t("dock.chat.proposal.discard")}
          </button>
        )}
      </div>
      {action.error || discard.error ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-danger)]">
          {t("dock.chat.proposal.failed")} {action.error ?? discard.error}
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
