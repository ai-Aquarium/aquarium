"use client";

import { useComposerPrefill } from "@/components/chat/composerPrefill";
import { useT } from "@/i18n";
import { optionReply, type OptionCard } from "@/lib/chat/option-cards";

/**
 * The approaches an agent offers while co-creating the playbook, each with
 * its pros and cons. Pick puts "Option B: …" in the composer to send or
 * amend; replying in your own words works just as well.
 */
export function OptionCards({ options }: { options: OptionCard[] }) {
  const t = useT("playbook");
  const prefill = useComposerPrefill();
  return (
    <div data-component="OptionCards" className="mt-2 flex flex-col gap-2">
      {options.map((option) => (
        <div
          key={option.label}
          data-option={option.label}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
        >
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[11px] font-semibold"
            >
              {option.label}
            </span>
            <span className="min-w-0 flex-1 font-semibold leading-snug">{option.title}</span>
            {prefill ? (
              <button
                type="button"
                data-action="pick-option"
                onClick={() => prefill(optionReply(option))}
                className="inline-flex min-h-9 shrink-0 items-center rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium hover:border-[var(--color-accent)]"
              >
                {t("options.pick", { label: option.label })}
              </button>
            ) : null}
          </div>
          {option.pros.length + option.cons.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-0.5 pl-7 text-xs">
              {option.pros.map((pro) => (
                <li key={`+${pro}`} className="flex gap-1.5">
                  <span aria-label={t("options.pro")} className="text-[var(--color-success)]">✓</span>
                  {pro}
                </li>
              ))}
              {option.cons.map((con) => (
                <li key={`-${con}`} className="flex gap-1.5">
                  <span aria-label={t("options.con")} className="text-[var(--color-danger)]">×</span>
                  {con}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      {prefill ? <p className="text-xs text-[var(--color-muted)]">{t("options.ownWords")}</p> : null}
    </div>
  );
}
