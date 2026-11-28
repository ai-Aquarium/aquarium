import { redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { InfoTip } from "@/components/ui/InfoTip";
import { FleetView } from "@/components/settings/FleetView";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { FleetStatus } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings → Fleet: the boxes this server manages, what runs where, and a
 * switch between direct deploy and software upgrade on each box. Owner only —
 * here, in the BFF and in the Python API — and only on a server that has a
 * fleet config; elsewhere the Settings tile stays hidden and this page shows
 * "not available".
 */
export default async function Page() {
  const principal = await requirePrincipal();
  if (!principal.is_owner) redirect("/not-available");
  let initial: FleetStatus;
  try {
    initial = await (await apiClientForRequest()).fleet();
  } catch (err) {
    initial = { available: false, error: err instanceof Error ? err.message : "" };
  }
  const t = await getT("settings");
  return (
    <MobileShell
      title={(await getT("fleet"))("title")}
      subtitle={t("entry.fleet.hint")}
      info={<InfoTip label={t("fleet.infoLabel")}>{t("fleet.info")}</InfoTip>}
    >
      <FleetView initial={initial} />
    </MobileShell>
  );
}
