"use client";

import { useT } from "@/i18n";

import { quoteForChat } from "./draftDiff";

/**
 * "Ask about this": quotes one paragraph, step, card or graph node into the
 * project chat's composer, labelled with where it came from.
 */
export function AskAboutButton({
  where,
  text,
  onAsk,
  className = "",
}: {
  /** Where the quote comes from, e.g. "v5 · step 2". */
  where: string;
  text: string;
  onAsk: (quote: string) => void;
  className?: string;
}) {
  const t = useT("playbook");
  return (
    <button
      type="button"
      data-action="ask-about"
      aria-label={t("askAbout.label", { where })}
      title={t("askAbout.title")}
      onClick={(e) => {
        e.stopPropagation();
        onAsk(quoteForChat(where, text));
      }}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] ${className}`}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
