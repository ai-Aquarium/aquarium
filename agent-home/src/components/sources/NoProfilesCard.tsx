"use client";

import { useId, useState } from "react";

import { BTN_PRIMARY, CARD } from "@/components/sources/ui";
import { useT } from "@/i18n/client";

/** Line-art fishbowl with a "…" speech bubble (Figma 74:2130 / 74:3024). */
function BowlWaiting() {
  return (
    <svg aria-hidden="true" width="84" height="96" viewBox="0 0 84 96" fill="none" className="mx-auto">
      <rect x="27" y="0" width="30" height="20" rx="8" fill="var(--color-accent)" />
      <path d="M36 20 l4 5 l4 -5 z" fill="var(--color-accent)" />
      <circle cx="35" cy="10" r="2.2" fill="var(--color-accent-fg)" />
      <circle cx="42" cy="10" r="2.2" fill="var(--color-accent-fg)" />
      <circle cx="49" cy="10" r="2.2" fill="var(--color-accent-fg)" />
      <circle cx="42" cy="33" r="4" fill="var(--color-accent)" />
      <ellipse cx="42" cy="46" rx="22" ry="4" stroke="var(--color-muted)" strokeWidth="2" />
      <path
        d="M24 48 C10 58 10 82 26 90 C34 94 50 94 58 90 C74 82 74 58 60 48"
        stroke="var(--color-muted)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * "You have no profiles yet" — no active enrolment anywhere, so nothing can
 * read a source. Shared by Settings › Sources and the register wizard's
 * Profiles step. "Ask an admin" opens the plain steps to get added: whoever
 * can add people is an admin of a profile this account isn't active in, so
 * there is no screen here to send them to. `viewerOnly`: enrolled, but a
 * viewer (read-only) everywhere, so the same card asks for a role change.
 */
export function NoProfilesCard({ viewerOnly = false }: { viewerOnly?: boolean }) {
  const t = useT("sources");
  const key = viewerOnly ? "wizard.viewerOnly" : "wizard.noProfiles";
  const [asking, setAsking] = useState(false);
  const hintId = useId();
  return (
    <div className={`${CARD} px-4 py-8 text-center sm:px-8`} data-testid={viewerOnly ? "viewer-only" : "no-profiles"}>
      <BowlWaiting />
      <p className="mt-4 text-lg font-semibold">{t(`${key}Title`)}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-muted)]">{t(`${key}Body`)}</p>
      <button
        type="button"
        data-action="ask-admin"
        aria-expanded={asking}
        aria-controls={hintId}
        onClick={() => setAsking((on) => !on)}
        className={`${BTN_PRIMARY} mx-auto mt-4`}
      >
        {t("wizard.askAdmin")}
      </button>
      {asking ? (
        <p
          id={hintId}
          role="note"
          data-testid="ask-admin-hint"
          className="mx-auto mt-3 max-w-md rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] p-3 text-left text-sm"
        >
          {t(viewerOnly ? "wizard.viewerOnlyAskHint" : "wizard.askAdminHint")}
        </p>
      ) : null}
    </div>
  );
}
