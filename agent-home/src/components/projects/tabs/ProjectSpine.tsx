"use client";

import type { ReactNode } from "react";

import { PROJECT_STEPS, type ProjectView } from "@/components/projects/tabs/sections";
import { useT } from "@/i18n";

/** What one spine card knows about its step. */
export interface SpineStepMeta {
  /** The pill beside the name — a version (`v3`) or a count (`6`). */
  pill?: string;
  /** One muted line under the name ("6 steps · from Requirements v5"). */
  sub?: string;
  /** Something in this step needs the user (amber dot). */
  warn?: boolean;
}

/**
 * The 2026-11-27 spine: Requirements → Plan → Cards → Runs as four equal
 * step cards (number, name, version/count pill, one muted line); the
 * selected step gets the accent border. On a phone it is a horizontal
 * scroller of chips with Chat appended as a fifth view.
 */
export function ProjectSpine({
  active,
  onSelect,
  meta,
  end,
}: {
  active: ProjectView;
  onSelect: (view: ProjectView) => void;
  meta: Record<string, SpineStepMeta>;
  /** Trailing control (the ⋯ sheet). */
  end?: ReactNode;
}) {
  const t = useT("projects");
  return (
    <nav
      data-component="ProjectSpine"
      data-active-view={active}
      aria-label={t("steps.aria")}
      className="flex min-w-0 max-w-full items-center gap-2"
    >
      <div role="tablist" className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {PROJECT_STEPS.map((step, i) => {
          const on = step === active;
          const m = meta[step] ?? {};
          return (
            <button
              key={step}
              type="button"
              role="tab"
              aria-selected={on}
              data-step={step}
              data-appmcp-hint={`Opens the ${t(`steps.${step}`)} step of this project`}
              onClick={() => onSelect(step)}
              className={`flex min-w-40 flex-1 flex-col gap-0.5 rounded-[var(--radius-lg)] border p-3 text-left ${
                on
                  ? "border-[var(--color-accent)] bg-[var(--color-surface)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]/50"
              }`}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span
                  aria-hidden
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                    on
                      ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                      : "border-[var(--color-border)] text-[var(--color-muted)]"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="truncate">{t(`steps.${step}`)}</span>
                {m.pill ? (
                  <span className="rounded-full bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-muted)]">
                    {m.pill}
                  </span>
                ) : null}
                {m.warn ? (
                  <span
                    aria-hidden
                    data-warn
                    title={t("steps.warn")}
                    className="ml-auto h-2 w-2 shrink-0 rounded-full bg-[var(--color-warn)]"
                  />
                ) : null}
              </span>
              {m.sub ? (
                <span className="truncate pl-6 text-xs text-[var(--color-muted)]">
                  {m.sub}
                </span>
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected={active === "chat"}
          data-step="chat"
          data-appmcp-hint="Opens this project's chat"
          onClick={() => onSelect("chat")}
          className={`flex min-w-24 shrink-0 flex-col justify-center gap-0.5 rounded-[var(--radius-lg)] border p-3 text-left lg:hidden ${
            active === "chat"
              ? "border-[var(--color-accent)] bg-[var(--color-surface)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)]"
          }`}
        >
          <span className="text-sm font-medium">{t("tabs.chat")}</span>
        </button>
      </div>
      {end}
    </nav>
  );
}
