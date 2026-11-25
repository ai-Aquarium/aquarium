"use client";

import { DetailsPill } from "@/components/landing/work/NeedsYouItem";
import { usePopover } from "@/components/landing/topbar/usePopover";
import { RefBadge } from "@/components/refs/RefBadge";
import { ActionButton } from "@/components/ui/ActionButton";
import { SNOOZE_OPTIONS, SUGGESTED_HINTS, senderOf, type SnoozeOption } from "@/lib/suggested-tasks/channels";
import type { SuggestedTask } from "@/types";

import { ChannelTag, SuggestedTag } from "./ChannelTag";

const BTN =
  "inline-flex min-h-10 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-sm disabled:opacity-50";
const PRIMARY =
  "inline-flex min-h-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50";

/**
 * One suggested task: what triage thinks the person may want to do, where it
 * came from, and the three choices — Work on this, Snooze, Dismiss.
 * `compact` drops the sender line (Projects strip, Needs you).
 */
export function SuggestedTaskCard({
  task,
  compact = false,
  canStart = true,
  onWork,
  onSnooze,
  onDismiss,
  onDetails,
}: {
  task: SuggestedTask;
  compact?: boolean;
  /** Viewers see suggestions but cannot start a task. */
  canStart?: boolean;
  onWork: (task: SuggestedTask) => void;
  onSnooze: (task: SuggestedTask, option: SnoozeOption) => Promise<unknown>;
  onDismiss: (task: SuggestedTask) => Promise<unknown>;
  /** Shows a Details pill (top right) and makes the title open it. */
  onDetails?: (task: SuggestedTask) => void;
}) {
  const { todo, source, channel } = task;
  const urgent = todo.priority === "critical" || todo.priority === "high";
  const why = (todo.description ?? "").replace(/\s+/g, " ").trim();
  const who = senderOf(source);
  const { open: snoozeOpen, setOpen: setSnoozeOpen, ref: snoozeRef } = usePopover<HTMLDivElement>();
  return (
    <article
      data-component="SuggestedTaskCard"
      aria-label={todo.title}
      data-todo={todo.id}
      data-channel={channel}
      className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SuggestedTag />
        <ChannelTag channel={channel} />
        {urgent ? (
          <span className="rounded-full border border-amber-500/50 px-2 py-0.5 text-[11px] font-medium leading-4 text-amber-400">
            Urgent
          </span>
        ) : null}
        {todo.stage === "staged" ? (
          <span
            title="Captured without notifying you"
            className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] leading-4 text-[var(--color-muted)]"
          >
            Quiet
          </span>
        ) : null}
        <RefBadge value={todo.ref} />
        {onDetails ? (
          <span className="ml-auto">
            <DetailsPill label="Details" onClick={() => onDetails(task)} />
          </span>
        ) : null}
      </div>
      {onDetails ? (
        <button
          type="button"
          data-testid="suggested-title"
          data-appmcp-hint={SUGGESTED_HINTS.title}
          onClick={() => onDetails(task)}
          className="text-left text-sm font-semibold leading-5 [overflow-wrap:anywhere] hover:underline"
        >
          {todo.title}
        </button>
      ) : (
        <p className="text-sm font-semibold leading-5 [overflow-wrap:anywhere]">{todo.title}</p>
      )}
      {why || (!compact && (who || source?.subject)) ? (
        <p className="line-clamp-2 text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">
          {why}
          {!compact && who ? `${why ? " · " : ""}from ${who}` : ""}
          {!compact && source?.subject ? `${why || who ? " · " : ""}${source.subject}` : ""}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-2">
        {canStart ? (
          <button type="button" data-action="suggested-work" data-appmcp-hint={SUGGESTED_HINTS.work} onClick={() => onWork(task)} className={PRIMARY}>
            Work on this
          </button>
        ) : null}
        <div ref={snoozeRef} className="relative">
          <button
            type="button"
            data-action="suggested-snooze"
            data-appmcp-hint={SUGGESTED_HINTS.snooze}
            aria-haspopup="menu"
            aria-expanded={snoozeOpen}
            onClick={() => setSnoozeOpen((v) => !v)}
            className={BTN}
          >
            Snooze
          </button>
          {snoozeOpen ? (
            <div
              role="menu"
              aria-label="Snooze for"
              className="absolute bottom-full left-0 z-[65] mb-1 w-28 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-1 shadow-xl"
            >
              {SNOOZE_OPTIONS.map((option) => (
                <ActionButton
                  key={option.id}
                  role="menuitem"
                  data-snooze={option.id}
                  data-appmcp-hint={SUGGESTED_HINTS.snoozeFor(option)}
                  onAction={async () => {
                    await onSnooze(task, option);
                    setSnoozeOpen(false);
                  }}
                  busyLabel={option.label}
                  className="block w-full rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                >
                  {option.label}
                </ActionButton>
              ))}
            </div>
          ) : null}
        </div>
        <ActionButton
          data-action="suggested-dismiss"
          data-appmcp-hint={SUGGESTED_HINTS.dismiss}
          onAction={() => onDismiss(task)}
          busyLabel="Dismissing…"
          className={`${BTN} border-transparent text-[var(--color-muted)]`}
        >
          Dismiss
        </ActionButton>
      </div>
    </article>
  );
}
