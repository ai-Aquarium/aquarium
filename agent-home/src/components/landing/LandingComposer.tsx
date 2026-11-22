"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { AquariumLoader } from "@/components/brand/AquariumLoader";
import { ArrowUpIcon, InfoIcon } from "@/components/ui/icons";
import { setHandOffAttachments } from "@/lib/chat/pending-attachments";
import { useAction } from "@/lib/use-action";
import type { ChatAttachment, ProfileSummary } from "@/types";

import { chatHref } from "./chats/chatsApi";
import { displayTitle, lastUpdated, type LandingSession } from "./chats/model";
import { useResumeChat } from "./chats/useResumeChat";
import { chatHandOffUrl, greetingFor } from "./startChat";
import { AttachButton, UploadChips } from "./UploadChips";
import { useLandingUploads } from "./useLandingUploads";

export const LANDING_SUGGESTIONS = [
  "What did my agents get done today?",
  "What needs my attention?",
  "Plan a new project with me",
  "Pick up where I left off",
] as const;

/**
 * The centre of the landing page (Figma `composer` 4:36): greeting, a large
 * message box and suggestion chips. Sending starts a new chat in the chosen
 * profile and opens it on the chat page with the message already sent,
 * together with any files attached here (Figma "Inner — Landing upload
 * files", 115:487).
 */
export function LandingComposer({
  profiles,
  currentProfile,
  needsYouCount = 0,
  name,
  onOpenChat,
  storageEnabled = false,
}: {
  profiles: ProfileSummary[];
  currentProfile: string;
  needsYouCount?: number;
  name?: string | null;
  /** Open the "Continue" chat in place (the landing page); without it the
   * chip navigates to the chat page. */
  onOpenChat?: (session: LandingSession) => void;
  /** File storage is set up on this box (else the paperclip is greyed out). */
  storageEnabled?: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [profile, setProfile] = useState(currentProfile);
  // Stays true after a successful hand-off so the button keeps its busy look
  // until the chat page replaces this one.
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const uploads = useLandingUploads();

  // Server and browser clocks can differ by an hour boundary; the h1
  // tolerates that mismatch rather than flashing a placeholder.
  const greeting = greetingFor(new Date().getHours());
  const trimmed = text.trim();

  const start = useAction(async (message: string, target: string, attachments: ChatAttachment[]) => {
    setError(null);
    try {
      if (target !== currentProfile) {
        // A profile is a whole HERMES_HOME: switch the session first so the
        // chat page, its history and the reply all belong to it.
        const res = await fetch("/api/session/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: target }),
        });
        if (!res.ok) throw new Error(`Couldn't switch to ${target}.`);
      }
      setLeaving(true);
      // After the switch: the files are the caller's own, in any profile.
      setHandOffAttachments(message, attachments);
      router.push(chatHandOffUrl(message));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the chat.");
    }
  });
  const pending = start.pending || leaving;

  function submit() {
    if (!trimmed || pending || uploads.busy) return;
    void start.run(trimmed, profile, uploads.attachments);
  }

  const hello = name ? `${greeting}, ${name}` : greeting;
  const subline =
    needsYouCount > 0
      ? `${needsYouCount} ${needsYouCount === 1 ? "thing needs" : "things need"} you`
      : "What should we work on?";
  const resume = useResumeChat(currentProfile);
  const attachedCount = uploads.attachments.length;
  const hint = pending
    ? { text: "Starting chat…", tone: "muted", phone: true }
    : uploads.busy
      ? { text: "Send unlocks when uploads finish", tone: "muted", phone: true }
      : uploads.failed > 0
        ? { text: "Failed files won't be sent", tone: "danger", phone: true }
        : {
            text: `Enter to send${
              attachedCount > 0 ? ` · ${attachedCount} ${attachedCount === 1 ? "file" : "files"} attached` : ""
            }`,
            tone: "muted",
            phone: false,
          };

  return (
    <section data-component="LandingComposer" className="flex w-full max-w-2xl flex-1 flex-col items-center gap-6 lg:flex-none">
      <div className="order-1 mt-auto text-center lg:mt-0">
        <h1 suppressHydrationWarning className="text-2xl font-semibold tracking-tight lg:text-3xl">{hello}</h1>
        <p
          data-testid="landing-subline"
          className={`mt-1 text-sm ${needsYouCount > 0 ? "text-[var(--color-warn-text)]" : "text-[var(--color-muted)]"}`}
        >
          {subline}
        </p>
        {resume ? (
          <ContinueChip
            session={resume}
            onOpen={
              onOpenChat
                ? () => onOpenChat(resume)
                : () => router.push(chatHref(resume.id, resume.profile ?? currentProfile))
            }
          />
        ) : null}
      </div>

      <form
        className="sticky bottom-0 order-3 w-full rounded-[var(--radius-2xl)] lg:static lg:order-2 border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm focus-within:border-[var(--color-accent)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <UploadChips
          items={uploads.items}
          locked={pending}
          onCancel={uploads.cancel}
          onRemove={uploads.remove}
          onRetry={uploads.retry}
        />
        {uploads.note ? (
          <p role="status" className="mb-2 flex items-center gap-1.5 px-1 text-xs text-[var(--color-muted)]">
            <InfoIcon size={14} />
            {uploads.note}
          </p>
        ) : null}
        <label htmlFor="landing-message" className="sr-only">
          Message
        </label>
        <textarea
          id="landing-message"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Ask anything, or describe a task…"
          disabled={pending}
          className="w-full resize-none bg-transparent px-2 py-1 text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)]"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {profiles.length > 1 ? (
              <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-muted)]">
                <span className="shrink-0">Profile</span>
                <select
                  aria-label="Profile for the new chat"
                  value={profile}
                  disabled={pending}
                  onChange={(e) => setProfile(e.target.value)}
                  className="min-w-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text)]"
                >
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                {profile !== currentProfile ? (
                  <span className="truncate text-[var(--color-accent)]">Starting in {profile}</span>
                ) : null}
              </label>
            ) : null}
          <AttachButton enabled={storageEnabled} locked={pending} onFiles={(files) => void uploads.add(files)} />
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span
              data-testid="landing-send-hint"
              aria-live="polite"
              className={`${hint.phone ? "" : "hidden sm:inline "}min-w-0 truncate text-xs ${
                hint.tone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"
              }`}
            >
              {hint.text}
            </span>
            <button
              type="submit"
              disabled={!trimmed || pending || uploads.busy}
              aria-label={pending ? "Starting chat" : "Start chat"}
              title={uploads.busy && !pending ? "Send unlocks when uploads finish" : undefined}
              className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-fg)] ${
                pending ? "" : "disabled:opacity-40"
              }`}
            >
              {pending ? <AquariumLoader size={20} label="Starting chat…" /> : <ArrowUpIcon size={18} />}
            </button>
          </div>
        </div>
      </form>
      {error ? (
        <p role="alert" className="order-4 text-sm lg:order-3 text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <ul aria-label="Suggestions" className="order-2 mb-auto flex flex-wrap justify-center gap-2 lg:order-4 lg:mb-0">
        {LANDING_SUGGESTIONS.map((s, i) => (
          <li key={s} className={i >= 2 ? "hidden lg:list-item" : undefined}>
            <button
              type="button"
              onClick={() => {
                setText(s);
                inputRef.current?.focus();
              }}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One-tap way back into the last chat, under the greeting: the Continue
 * pill the sidebar's resume row wears, plus the chat's title and when it
 * was last touched.
 */
function ContinueChip({ session, onOpen }: { session: LandingSession; onOpen: () => void }) {
  const { text, untitled } = displayTitle(session);
  const updated = lastUpdated(session);
  return (
    <button
      type="button"
      data-component="ContinueChip"
      onClick={onOpen}
      title={updated ? `Last updated ${updated.full}` : undefined}
      className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--color-accent)] bg-[var(--color-surface)] py-1.5 pl-1.5 pr-3 text-sm shadow-sm hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <span
        data-slot="continue-badge"
        className="shrink-0 rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--color-accent-fg)]"
      >
        Continue
      </span>
      <span
        data-slot="continue-title"
        className={`min-w-0 truncate ${untitled ? "italic text-[var(--color-muted)]" : "font-medium text-[var(--color-fg)]"}`}
      >
        {text}
      </span>
      {updated ? (
        <span data-slot="continue-updated" className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">
          {updated.label}
        </span>
      ) : null}
    </button>
  );
}
