import { BADGE_LABEL, type LayerBadge } from "@/lib/triage/layers";

const TONE: Record<LayerBadge, string> = {
  mine: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  template: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
  builtin: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
  off: "bg-[var(--color-warn)]/15 text-[var(--color-warn-text)]",
};

/** Which layer wins for a file: Mine / Template / Built-in / Off. */
export function LayerTag({ badge }: { badge: LayerBadge }) {
  return (
    <span
      data-layer={badge}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[badge]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {BADGE_LABEL[badge]}
    </span>
  );
}
