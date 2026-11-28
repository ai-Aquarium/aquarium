import { MobileShell } from "@/components/MobileShell";
import { SettingsView } from "@/components/settings/SettingsView";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canManageTools } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/**
 * Settings index: one tile per section the caller may open. Each tile opens
 * that section's own page (`/settings/[section]`, or its existing route).
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("settings");
  // The Fleet tile only exists where this server manages a fleet; the probe is
  // cheap (no SSH) and only the owner can ever see the tile.
  let hasFleet = false;
  if (principal.is_owner) {
    try {
      hasFleet = Boolean((await (await apiClientForRequest()).fleetAvailable()).available);
    } catch {
      hasFleet = false;
    }
  }
  return (
    <MobileShell
      title={t("title")}
      subtitle={t("subtitle")}
      info={<InfoTip label={t("infoLabel")}>{t("info")}</InfoTip>}
      wide
    >
      <SettingsView
        canManageMembers={principal.is_owner || principal.role === "admin"}
        canManageTools={canManageTools(principal)}
        isOwner={principal.is_owner}
        hasFleet={hasFleet}
      />
    </MobileShell>
  );
}
