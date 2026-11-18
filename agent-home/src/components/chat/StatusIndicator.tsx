"use client";

import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { useNow } from "@/lib/use-now";

/**
 * Animated agent-activity indicator for the chat pane.
 *
 * Gives the user a live signal that the agent is actually working, since
 * a streamed turn can otherwise look frozen between tokens. Phases:
 *   - `sending`   — the message left the browser, no server ack yet;
 *   - `thinking`  — turn accepted, no text yet (the model is composing);
 *   - `tool`      — a tool call is running (`detail` names it);
 *   - `streaming` — tokens are arriving (the reply is being written);
 *   - `waiting_approval` — a gated tool is blocked on the user's decision;
 *   - `waiting_secret` — the agent asked for a secret (FG-37 popup);
 *   - `stopping`  — the user hit Stop; the server is winding the turn down.
 * Thinking/writing name the answering profile (`Agent finance is thinking…`).
 * Every active phase shows the elapsed time so a long turn visibly advances.
 * Rendered as an aria-live region so the state is also announced to AT.
 */
export type ChatActivity =
  | "idle"
  | "sending"
  | "thinking"
  | "tool"
  | "streaming"
  | "waiting_approval"
  | "waiting_secret"
  | "stopping";

/** Silence (no assistant text yet) after which we explain the wait. */
export const LONG_TASK_HINT_MS = 20_000;
/** No stream event of any kind for this long reads as a possible stall. */
export const STALL_WARNING_MS = 90_000;

/** Message keys (`chatStatus` namespace); `*Unnamed` when no profile is known. */
const LABEL_KEYS: Record<
  Exclude<ChatActivity, "idle" | "tool">,
  { named: string; unnamed: string }
> = {
  sending: { named: "sending", unnamed: "sending" },
  thinking: { named: "thinking", unnamed: "thinkingUnnamed" },
  streaming: { named: "writing", unnamed: "writingUnnamed" },
  waiting_approval: { named: "waitingApproval", unnamed: "waitingApproval" },
  waiting_secret: { named: "waitingSecret", unnamed: "waitingSecret" },
  stopping: { named: "stopping", unnamed: "stopping" },
};

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
          style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }}
        />
      ))}
    </span>
  );
}

export function StatusIndicator({
  activity,
  elapsedMs: elapsedProp,
  detail,
  quietMs: quietProp,
  hasOutput = false,
  startedAt,
  lastEventAt,
  compact = false,
  profileName,
}: {
  activity: ChatActivity;
  /** Time since the user sent the message; omitted → no clock. */
  elapsedMs?: number;
  /** Phase detail, e.g. the running tool's name. */
  detail?: string;
  /** Time since the last stream event of any kind (for stall detection). */
  quietMs?: number;
  /** Whether any assistant text has arrived yet. */
  hasOutput?: boolean;
  /** Turn start (epoch ms): the clock is computed here when `elapsedMs` is omitted. */
  startedAt?: number;
  /** Last stream event (epoch ms): quiet time is computed here when `quietMs` is omitted. */
  lastEventAt?: number;
  /** Small inline line (no pill box) for use inside a reply bubble. */
  compact?: boolean;
  /** The profile answering this turn, named in the thinking/writing label. */
  profileName?: string;
}) {
  const t = useT("chatStatus");
  // Self-ticking only when the parent hands timestamps instead of durations,
  // so the 1-second re-render stays inside this component.
  const selfTimed =
    (elapsedProp === undefined && startedAt !== undefined) ||
    (quietProp === undefined && lastEventAt !== undefined);
  const now = useNow(selfTimed && activity !== "idle");
  const elapsedMs =
    elapsedProp ??
    (startedAt !== undefined ? Math.max(0, now - startedAt) : undefined);
  const quietMs =
    quietProp ??
    (lastEventAt !== undefined ? Math.max(0, now - lastEventAt) : undefined);
  if (activity === "idle") return null;
  const waiting = activity === "waiting_approval" || activity === "waiting_secret";
  const name = profileName?.trim();
  const label =
    activity === "tool"
      ? detail
        ? t("runningTool", { tool: detail })
        : t("runningAnyTool")
      : name
        ? t(LABEL_KEYS[activity].named, { name })
        : t(LABEL_KEYS[activity].unnamed);
  const clock =
    elapsedMs !== undefined && elapsedMs >= 1000 ? formatElapsed(elapsedMs) : null;
  const stopping = activity === "stopping";
  const stalled = !waiting && !stopping && (quietMs ?? 0) >= STALL_WARNING_MS;
  const longTask =
    !waiting &&
    !stopping &&
    !stalled &&
    !hasOutput &&
    (elapsedMs ?? 0) >= LONG_TASK_HINT_MS;
  const pill = compact
    ? `inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] ${
        waiting ? "animate-pulse text-[var(--color-accent)]" : ""
      }`
    : `inline-flex items-center gap-2 rounded-2xl border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium text-[var(--color-accent)] ${
        waiting ? "animate-pulse" : ""
      }`;
  return (
    <div
      data-component="StatusIndicator"
      data-activity={activity}
      data-compact={compact ? "true" : undefined}
      role="status"
      aria-live="polite"
      className={`flex flex-col items-start ${compact ? "gap-0.5" : "gap-1"}`}
    >
      <span className={pill}>
        {waiting ? (
          <Dots />
        ) : (
          <Spinner className={compact ? "text-[var(--color-accent)]" : ""} />
        )}
        <span>{label}</span>
        {clock ? (
          <span
            data-component="StatusElapsed"
            className="tabular-nums text-xs font-normal opacity-70"
          >
            {clock}
          </span>
        ) : null}
      </span>
      {stalled ? (
        <p
          data-component="StatusStallWarning"
          className="max-w-prose px-1 text-xs text-[var(--color-warn-text)]"
        >
          {t("stalled", { elapsed: formatElapsed(quietMs ?? 0) })}
        </p>
      ) : stopping ? (
        <p
          data-component="StatusStoppingHint"
          className="max-w-prose px-1 text-xs text-[var(--color-muted)]"
        >
          {t("stoppingHint")}
        </p>
      ) : longTask ? (
        <p
          data-component="StatusLongTaskHint"
          className="max-w-prose px-1 text-xs text-[var(--color-muted)]"
        >
          {t("longTask")}
        </p>
      ) : null}
    </div>
  );
}
