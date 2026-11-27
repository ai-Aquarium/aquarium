import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { Pill } from "@/components/ui/Pill";
import type { ReactNode } from "react";

/**
 * The versions column the Requirements and Plan steps share (redesign
 * mockups): newest first, `Current` on the live version, a `Not saved`
 * row on top when edits or agent proposals are pending, and a "Used by"
 * footer naming what builds on this document.
 */
export interface VersionRow {
  /** Ordinal version (v1 = first draft). */
  rev: number;
  current?: boolean;
  /** Rows above `current` — the unsaved / proposed draft. */
  pending?: boolean;
  note: string;
  author?: string | null;
  at?: number | null;
  /** e.g. "2 agent edits waiting" on the pending row. */
  waiting?: string | null;
}

export function VersionRail({
  title = "Versions",
  rows,
  usedBy,
}: {
  title?: string;
  rows: VersionRow[];
  usedBy?: ReactNode;
}) {
  const timeLabel = useTimeLabel();
  return (
    <aside
      data-component="VersionRail"
      aria-label={title}
      className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title}
      </h3>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={r.rev}
            className={`rounded-[var(--radius-md)] border px-2.5 py-2 ${
              r.current
                ? "border-[var(--color-accent)]"
                : r.pending
                  ? "border-[var(--color-warn)]"
                  : "border-[var(--color-border)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">v{r.rev}</span>
              {r.pending ? <Pill tone="warning">Not saved</Pill> : null}
              {r.current ? <Pill tone="accent">Current</Pill> : null}
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              {[
                r.author,
                r.at != null ? timeLabel(r.at, "ago") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {r.author || r.at != null ? " — " : ""}
              {r.note}
            </p>
            {r.waiting ? (
              <p className="mt-0.5 text-xs text-[var(--color-warn-text)]">
                {r.waiting}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {usedBy ? (
        <div className="mt-1 border-t border-[var(--color-border)] pt-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Used by
          </h4>
          <div className="mt-1 text-xs text-[var(--color-muted)]">{usedBy}</div>
        </div>
      ) : null}
    </aside>
  );
}
