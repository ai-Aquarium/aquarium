"use client";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { useT, type Translator } from "@/i18n";
import type { RouteChoice, RoutingDecision } from "@/types";
import { displaySender } from "@/lib/sources/mask";

type Translate = Translator;

/** The popover / sheet title for one decision, seen from `profile`. */
export function routingDecisionTitle(
  t: Translate,
  decision: RoutingDecision,
  profile?: string | null,
): string {
  if (decision.fallback) return t("titleAll");
  const selected = decision.choices.filter((c) => c.selected).map((c) => c.profile);
  if (selected.length === 0) return t("titleNone");
  if (profile && selected.includes(profile)) return t("titleOne", { profile });
  if (selected.length === 1) return t("titleOne", { profile: selected[0] });
  return t("titleSome");
}

/**
 * The router's last error, only when it is short, one line and plain words:
 * a provider message can carry URLs, paths or request ids nobody should see.
 */
export function safeRoutingError(error: string | null | undefined): string | null {
  const text = error?.trim();
  if (!text || text.length > 120 || /[\r\n]/.test(text)) return null;
  if (/https?:|www\.|[/\\]|[{}<>=`$]|\b(?:sk|key|token|bearer)\b/i.test(text)) return null;
  return text;
}

function batchSize(t: Translate, decision: RoutingDecision): string | null {
  const count = decision.message_count;
  if (typeof count !== "number" || count < 1) return null;
  const emails = decision.channel === "email";
  if (count === 1) return t(emails ? "batchEmail" : "batchMessage");
  return t(emails ? "batchEmails" : "batchMessages", { count });
}

function decidedTime(iso: string | null): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "From john@acme.com · batch of 3 emails · 10:42 · 1 try" — the parts we have. */
export function routingMetaLine(t: Translate, decision: RoutingDecision): string {
  const attempts = decision.attempts;
  return [
    decision.first_sender?.trim() ? t("from", { sender: displaySender(decision.channel, decision.first_sender.trim()) }) : null,
    batchSize(t, decision),
    decidedTime(decision.decided_at),
    attempts > 0 ? (attempts === 1 ? t("tryOne") : t("tryMany", { count: attempts })) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const PILL =
  "inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-xs font-medium leading-4";

function ChoicePill({ t, choice, fallback }: { t: Translate; choice: RouteChoice; fallback: boolean }) {
  const [label, tone, dot] = fallback && choice.selected
    ? [t("gotItFallback"), "text-[var(--color-warn-text)]", "bg-[var(--color-warn)]"]
    : choice.selected
      ? [t("gotIt"), "text-[var(--color-success)]", "bg-[var(--color-success)]"]
      : [t("skipped"), "text-[var(--color-muted)]", "bg-[var(--color-muted)]"];
  return (
    <span data-testid="route-choice-status" className={`${PILL} ${tone}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

/**
 * Figma 4a / 4b (FG-03 P7): which of the owner's profiles got one batch and
 * why — one row per profile (Got it / Skipped and the router's one-line
 * reason), the fallback warning when the check failed every try, and what
 * "no profile" means. Body only: the caller owns the title, close and links,
 * so the Sources page can list several of these.
 */
export function RoutingDecisionCard({ decision }: { decision: RoutingDecision }) {
  const t = useT("routing");
  const meta = routingMetaLine(t, decision);
  const anySelected = decision.choices.some((c) => c.selected);
  const error = safeRoutingError(decision.error);
  return (
    <div
      data-component="RoutingDecisionCard"
      data-fallback={decision.fallback || undefined}
      className="flex min-w-0 flex-col gap-3"
    >
      {meta ? (
        <p className="text-xs font-medium leading-4 text-[var(--color-muted)] [overflow-wrap:anywhere]">{meta}</p>
      ) : null}
      {decision.fallback ? (
        <InlineAlert tone="warn">
          <span className="text-[var(--color-fg)]">
            {decision.attempts > 1 ? t("fallback", { count: decision.attempts }) : t("fallbackOnce")}
          </span>
        </InlineAlert>
      ) : (
        <p className="text-[13px] leading-[18px] text-[var(--color-muted)]">{t("explain")}</p>
      )}
      {!decision.fallback && !anySelected ? (
        <InlineAlert tone="info">{t("storedOnly")}</InlineAlert>
      ) : null}
      {decision.choices.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {decision.choices.map((choice) => (
            <li
              key={choice.profile}
              data-testid="route-choice"
              data-profile={choice.profile}
              data-selected={choice.selected}
              className="flex items-start gap-2.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px] leading-[18px]">
                <p className="font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]">{choice.profile}</p>
                <p className="text-[var(--color-muted)] [overflow-wrap:anywhere]">
                  {choice.reason?.trim() || (decision.fallback ? t("noReason") : t("noReasonGiven"))}
                </p>
              </div>
              <ChoicePill t={t} choice={choice} fallback={decision.fallback} />
            </li>
          ))}
        </ul>
      ) : null}
      {decision.model || error ? (
        <p className="text-xs leading-4 text-[var(--color-muted)] [overflow-wrap:anywhere]">
          {[decision.model ? t("model", { model: decision.model }) : null, error ? t("error", { error }) : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <p className="text-xs leading-4 text-[var(--color-muted)]">{t("replies")}</p>
    </div>
  );
}
