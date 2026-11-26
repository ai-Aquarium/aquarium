import type { CardState } from "@/components/projects/execution/runStats";
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  LoaderIcon,
} from "@/components/ui/icons";
import type { Tone } from "@/components/ui/Pill";
import type { ProjectRunStatus } from "@/types";

export const CARD =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";

export const LABEL =
  "text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]";

export const RUN_TONE: Record<ProjectRunStatus, Tone> = {
  running: "accent",
  waiting: "warning",
  blocked: "danger",
  done: "success",
  failed: "danger",
  cancelled: "muted",
};

export const STATE_CLASS: Record<CardState, string> = {
  done: "text-[var(--color-success)]",
  running: "text-[var(--color-accent)]",
  needs: "text-[var(--color-warn-text)]",
  todo: "text-[var(--color-muted)]",
  skipped: "text-[var(--color-muted)]",
};

export function StateIcon({ state }: { state: CardState }) {
  if (state === "done") return <CheckIcon size={14} aria-hidden />;
  if (state === "running") return <LoaderIcon size={14} aria-hidden />;
  if (state === "needs") return <AlertIcon size={14} aria-hidden />;
  return <ClockIcon size={14} aria-hidden />;
}

export function versionLabel(rev: number | null | undefined): string {
  return rev != null ? `v${rev}` : "—";
}
