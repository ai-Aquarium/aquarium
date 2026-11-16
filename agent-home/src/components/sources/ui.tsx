"use client";

import type { ReactNode } from "react";

import { CHANNEL_BADGE } from "@/lib/sources/api";
import type { SourceChannel } from "@/types";

export const BTN_PRIMARY =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50";
export const BTN_SECONDARY =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";
export const BTN_GHOST =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-50";
export const BTN_DANGER =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-xl bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50";
export const CARD = "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]";

/** `@` / `WA` / `TG` square badge used on every source row. */
export function ChannelBadge({ channel }: { channel: SourceChannel }) {
  return (
    <span
      aria-hidden
      data-component="ChannelBadge"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[11px] font-semibold text-[var(--color-accent)]"
    >
      {CHANNEL_BADGE[channel]}
    </span>
  );
}

/** A profile chip: outlined accent when on, muted with a suffix when paused/skipped. */
export function ProfileChip({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span
      data-component="ProfileChip"
      data-on={on ? "true" : "false"}
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${
        on
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-transparent bg-[var(--color-surface-2)] text-[var(--color-muted)]"
      }`}
    >
      {children}
    </span>
  );
}

/** Token-only on/off switch; the caller owns the busy lock. */
export function Switch({
  on,
  label,
  busy = false,
  disabled = false,
  onToggle,
}: {
  on: boolean;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy}
      data-busy={busy ? "true" : "false"}
      disabled={disabled || busy}
      onClick={onToggle}
      className="inline-flex h-9 w-11 items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`relative block h-5 w-9 rounded-full transition-colors ${
          on ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-border)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-[var(--color-fg)] transition-all ${on ? "left-[1.125rem]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}
