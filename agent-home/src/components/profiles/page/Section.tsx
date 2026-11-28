import type { ReactNode } from "react";

/** One titled card on the agent-profile page — the shared chrome for every section. */
export function Section({
  title,
  hint,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-component="ProfilePageSection"
      className={`rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${className}`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {hint ? <p className="mt-0.5 text-xs text-[var(--color-muted)]">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The inset, scrollable list box used for skills / sources / history rows. */
export function ListBox({ children }: { children: ReactNode }) {
  return (
    <ul
      data-component="ProfileListBox"
      className="max-h-72 divide-y divide-[var(--color-border)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)]"
    >
      {children}
    </ul>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-4 text-center text-xs text-[var(--color-muted)]">
      {children}
    </p>
  );
}
