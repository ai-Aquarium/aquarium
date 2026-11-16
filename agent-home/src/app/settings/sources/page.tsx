import { MobileShell } from "@/components/MobileShell";
import { RegisterSourceLink } from "@/components/sources/RegisterSourceLink";
import { SourcesView } from "@/components/sources/SourcesView";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { SourcesList } from "@/lib/sources/api";
import type { SourceClaimConflict } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings › Sources (FG-03 P7): the caller's mailboxes, WhatsApp numbers and
 * Telegram bots, which of their profiles read each one, and open claims.
 */
export default async function Page() {
  await requirePrincipal();
  const client = await apiClientForRequest();
  const t = await getT("sources");

  let list: SourcesList | null = null;
  let error: string | null = null;
  try {
    list = await client.sources();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }
  let conflicts: SourceClaimConflict[] = [];
  if (list) {
    try {
      conflicts = (await client.sourceConflicts(list.is_box_admin)).conflicts;
    } catch {
      conflicts = [];
    }
  }

  return (
    <MobileShell
      title={t("title")}
      subtitle={t("subtitle")}
      info={<InfoTip label={t("infoLabel")}>{t("info")}</InfoTip>}
      actions={list ? <RegisterSourceLink /> : undefined}
      wide
    >
      {list ? (
        <SourcesView initial={list} initialConflicts={conflicts} />
      ) : (
        <div data-component="SourcesError">
          <ErrorState kind="error" details={error} />
        </div>
      )}
    </MobileShell>
  );
}
