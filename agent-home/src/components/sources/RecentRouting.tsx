"use client";

import Link from "next/link";
import { useState } from "react";

import { RoutingDecisionCard, routingDecisionTitle } from "@/components/sources/RoutingDecisionCard";
import { BTN_GHOST, CARD, ProfileChip } from "@/components/sources/ui";
import { Pill, type Tone } from "@/components/ui/Pill";
import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n/client";
import { decisionOutcome, type DecisionOutcome } from "@/lib/sources/api";
import type { RoutingDecision, Source } from "@/types";

const OUTCOME_TONE: Record<DecisionOutcome, Tone> = { routed: "success", stored: "muted", fallback: "warning" };

/** `10:42` today, `Yesterday`, else a short date. */
export function decisionWhen(iso: string | null, now: Date, yesterday: string): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (diff === 1) return yesterday;
  return at.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Recent routing for one source (FG-03 P7, Figma 4c). */
export function RecentRouting({
  sources,
  sourceId,
  decisions,
  limit,
  now = new Date(),
}: {
  sources: Source[];
  sourceId: string;
  decisions: RoutingDecision[];
  limit: number;
  now?: Date;
}) {
  const t = useT("sources");
  const tr = useT("routing");
  const [why, setWhy] = useState<RoutingDecision | null>(null);
  const whyButton = (d: RoutingDecision) => (
    <button
      type="button"
      data-action="why-routed"
      aria-label={t("routing.whyLabel", { id: d.batch_id })}
      aria-haspopup="dialog"
      className={`${BTN_GHOST} !min-h-0 px-1.5 py-0.5 text-xs text-[var(--color-accent)]`}
      onClick={() => setWhy(d)}
    >
      {t("routing.why")}
    </button>
  );
  const reason = (d: RoutingDecision): string => {
    const outcome = decisionOutcome(d);
    if (outcome === "fallback") return t("routing.fallbackReason", { attempts: d.attempts });
    if (outcome === "stored") return t("routing.storedReason");
    return d.choices
      .filter((c) => c.selected && c.reason)
      .map((c) => `${c.profile}: ${c.reason}`)
      .join(" · ");
  };
  const meta = (d: RoutingDecision): string =>
    [
      d.message_count == null ? null : d.message_count === 1 ? t("routing.message") : t("routing.messages", { count: d.message_count }),
      d.first_sender ? t("routing.from", { sender: d.first_sender }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const chips = (d: RoutingDecision) => {
    const names = d.choices.length ? d.choices.map((c) => c.profile) : d.selected;
    return names.map((p) => {
      const on = d.selected.includes(p);
      return (
        <ProfileChip key={p} on={on}>
          {on ? p : t("routing.skipped", { profile: p })}
        </ProfileChip>
      );
    });
  };

  return (
    <div data-component="RecentRouting" className="space-y-4">
      {sources.length > 1 ? (
        <nav aria-label={t("title")} className="flex flex-wrap gap-2">
          {sources.map((s) => (
            <Link
              key={s.source_id}
              href={`/settings/sources/${encodeURIComponent(s.source_id)}/routing`}
              replace
              aria-current={s.source_id === sourceId ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-xs ${
                s.source_id === sourceId
                  ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg)]"
              }`}
            >
              {s.address}
            </Link>
          ))}
        </nav>
      ) : null}

      {decisions.length === 0 ? (
        <div className={`${CARD} px-4 py-8 text-center text-sm text-[var(--color-muted)]`} data-testid="routing-empty">
          {t("routing.empty")}
        </div>
      ) : (
        <>
          <table className={`${CARD} hidden w-full border-separate border-spacing-0 overflow-hidden text-sm sm:table`}>
            <thead className="text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="border-b border-[var(--color-border)] px-4 py-2.5 font-medium">{t("routing.when")}</th>
                <th className="border-b border-[var(--color-border)] px-4 py-2.5 font-medium">{t("routing.gotIt")}</th>
                <th className="border-b border-[var(--color-border)] px-4 py-2.5 font-medium">{t("routing.reason")}</th>
                <th className="border-b border-[var(--color-border)] px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => {
                const outcome = decisionOutcome(d);
                const last = i === decisions.length - 1 ? "" : "border-b border-[var(--color-border)]";
                return (
                  <tr key={d.decision_id ?? d.batch_id} data-outcome={outcome}>
                    <td className={`${last} px-4 py-3 align-top`}>
                      <p className="font-medium">{decisionWhen(d.decided_at, now, t("routing.yesterday"))}</p>
                      <p className="text-xs text-[var(--color-muted)]">{t("routing.batch", { id: d.batch_id })}</p>
                    </td>
                    <td className={`${last} px-4 py-3 align-top`}>
                      <div className="flex flex-wrap gap-1.5">{chips(d)}</div>
                    </td>
                    <td className={`${last} px-4 py-3 align-top`}>
                      <p className={outcome === "fallback" ? "text-[var(--color-warn-text)]" : "text-[var(--color-muted)]"}>{reason(d)}</p>
                      {meta(d) ? <p className="text-xs text-[var(--color-muted)]">{meta(d)}</p> : null}
                    </td>
                    <td className={`${last} px-4 py-3 text-right align-top`}>
                      <div className="flex flex-col items-end gap-1">
                        <Pill tone={OUTCOME_TONE[outcome]}>● {t(`routing.outcome.${outcome}`)}</Pill>
                        {whyButton(d)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="space-y-2 sm:hidden">
            {decisions.map((d) => {
              const outcome = decisionOutcome(d);
              return (
                <li key={d.decision_id ?? d.batch_id} data-outcome={outcome} className={`${CARD} space-y-2 p-3 text-sm`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{decisionWhen(d.decided_at, now, t("routing.yesterday"))}</p>
                      <p className="text-xs text-[var(--color-muted)]">{t("routing.batch", { id: d.batch_id })}</p>
                    </div>
                    <Pill tone={OUTCOME_TONE[outcome]}>● {t(`routing.outcome.${outcome}`)}</Pill>
                  </div>
                  <div className="flex flex-wrap gap-1.5">{chips(d)}</div>
                  <p className={outcome === "fallback" ? "text-[var(--color-warn-text)]" : "text-[var(--color-muted)]"}>{reason(d)}</p>
                  {meta(d) ? <p className="text-xs text-[var(--color-muted)]">{meta(d)}</p> : null}
                  <div className="-mb-1 flex justify-end">{whyButton(d)}</div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="text-xs text-[var(--color-muted)]">{t("routing.footer", { limit })}</p>
      {why ? (
        <Sheet title={routingDecisionTitle(tr, why)} onClose={() => setWhy(null)} component="RecentRoutingWhySheet">
          <RoutingDecisionCard decision={why} />
        </Sheet>
      ) : null}
    </div>
  );
}
