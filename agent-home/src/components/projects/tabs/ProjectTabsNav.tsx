"use client";

import type { ReactNode } from "react";

import { PHONE_SECTIONS, type PhoneSection } from "@/components/projects/tabs/sections";
import { useT } from "@/i18n";

/**
 * Planning · Execution · Log (2026-11-22 redesign), plus Chat on a phone,
 * where the chat is a tab instead of the dock. Scrolls sideways inside itself
 * (never the page) if a translation runs long.
 */
export function ProjectTabsNav({
  active,
  onSelect,
  badges = {},
  end,
}: {
  active: PhoneSection;
  onSelect: (section: PhoneSection) => void;
  /** e.g. `{ execution: 3 }` — how many things in that section need a person. */
  badges?: Partial<Record<PhoneSection, number>>;
  /** Trailing control (the ⋯ sheet). */
  end?: ReactNode;
}) {
  const t = useT("projects");
  return (
    <nav
      data-component="ProjectTabsNav"
      aria-label={t("tabs.aria")}
      className="flex min-w-0 max-w-full items-center gap-2"
    >
      <div className="min-w-0 overflow-x-auto">
        <ul
          role="tablist"
          className="flex w-max gap-0.5 rounded-[var(--radius-lg)] lg:gap-1 border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
        >
          {PHONE_SECTIONS.map((section) => {
            const on = section === active;
            const badge = badges[section] ?? 0;
            return (
              <li key={section} className={section === "chat" ? "lg:hidden" : undefined}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  data-tab={section}
                  onClick={() => onSelect(section)}
                  className={`flex h-9 items-center gap-1 whitespace-nowrap rounded-[var(--radius-md)] px-2.5 text-sm lg:gap-1.5 lg:px-3 ${
                    on
                      ? "bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]"
                      : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                  }`}
                >
                  {t(`tabs.${section}`)}
                  {badge > 0 ? (
                    <span className="rounded-[var(--radius-full)] bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold text-[var(--color-accent-fg)]">
                      {badge}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {end}
    </nav>
  );
}
