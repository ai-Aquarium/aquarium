"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { switchSessionProfile } from "@/components/ProfileSwitcher";
import { NoProfilesCard } from "@/components/sources/NoProfilesCard";
import { RegisterSourceWizard } from "@/components/sources/RegisterSourceWizard";
import { BTN_PRIMARY, CARD } from "@/components/sources/ui";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { useT } from "@/i18n/client";
import type { SourcesList } from "@/lib/sources/api";

const NO_PROFILES: SourcesList = { sources: [], profiles: [], is_box_admin: false };

/**
 * Settings › Sources for an account with no active enrolment anywhere: the
 * approved "You have no profiles yet" explanation, and Register still opens
 * the wizard (on its Profiles step, which says the same thing).
 */
export function SourcesNoProfiles() {
  const router = useRouter();
  const pathname = usePathname();
  const registering = useSearchParams()?.get("register") === "1";
  return (
    <div data-component="SourcesNoProfiles">
      <NoProfilesCard />
      {registering ? (
        <RegisterSourceWizard
          list={NO_PROFILES}
          onClose={() => router.replace(pathname, { scroll: false })}
          onRegistered={() => undefined}
        />
      ) : null}
    </div>
  );
}

/**
 * The session's profile suspended this account but others still hold it:
 * say so, and offer the active profiles (one switch at a time). Nothing of
 * the suspended profile is read.
 */
export function SourcesSuspended({ current, others }: { current: string; others: string[] }) {
  const t = useT("sources");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Once a switch succeeded the page is re-rendering in the new profile:
  // every button stays locked so a second switch can't race it.
  const [switched, setSwitched] = useState<string | null>(null);
  return (
    <div className={`${CARD} px-4 py-8 text-center sm:px-8`} data-component="SourcesSuspended">
      <p className="text-lg font-semibold">{t("suspendedTitle", { profile: current })}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-muted)]">
        {t("suspendedBody", { profile: current })}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {others.map((p) => (
          <ActionButton
            key={p}
            data-action="switch-profile"
            data-profile={p}
            className={BTN_PRIMARY}
            busy={switched === p}
            disabled={switched !== null}
            busyLabel={t("switching")}
            onAction={async () => {
              setError(null);
              const r = await switchSessionProfile(p);
              if (!r.ok) {
                setError(r.error);
                return;
              }
              setSwitched(p);
              router.refresh();
            }}
          >
            {t("switchTo", { profile: p })}
          </ActionButton>
        ))}
      </div>
      {error ? (
        <div className="mx-auto mt-3 max-w-md text-left">
          <InlineAlert tone="danger">{error}</InlineAlert>
        </div>
      ) : null}
    </div>
  );
}
