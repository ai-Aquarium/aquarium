import { MobileShell } from "@/components/MobileShell";
import { RegisterSourceLink } from "@/components/sources/RegisterSourceLink";
import { SourcesNoProfiles, SourcesSuspended } from "@/components/sources/SourcesNoProfile";
import { SourcesView } from "@/components/sources/SourcesView";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { activeEnrolments } from "@/lib/api/my-profiles";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
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
  // A 403 here is usually the session's profile refusing a suspended
  // enrolment. Hermes keeps refusing (nothing of that profile is read); the
  // box-wide enrolment list only decides which explanation to show.
  let noAccess: { kind: "none" } | { kind: "suspended"; current: string; others: string[] } | null = null;
  try {
    list = await client.sources();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
    if (err instanceof HermesApiError && err.status === 403) {
      const active = await client
        .myProfiles()
        .then((r) => activeEnrolments(r).map((p) => p.name))
        .catch(() => null);
      const current = (await readSession())?.profile ?? "default";
      if (active && active.length === 0) noAccess = { kind: "none" };
      else if (active && !active.includes(current)) noAccess = { kind: "suspended", current, others: active };
    }
  }
  let conflicts: SourceClaimConflict[] = [];
  let conflictsFailed = false;
  if (list) {
    try {
      conflicts = (await client.sourceConflicts(list.is_box_admin)).conflicts;
    } catch {
      conflictsFailed = true;
    }
  }

  return (
    <MobileShell
      title={t("title")}
      subtitle={t("subtitle")}
      info={<InfoTip label={t("infoLabel")}>{t("info")}</InfoTip>}
      actions={list || noAccess?.kind === "none" ? <RegisterSourceLink /> : undefined}
      wide
    >
      {list ? (
        <SourcesView initial={list} initialConflicts={conflicts} initialConflictsFailed={conflictsFailed} />
      ) : noAccess?.kind === "none" ? (
        <SourcesNoProfiles />
      ) : noAccess?.kind === "suspended" ? (
        <SourcesSuspended current={noAccess.current} others={noAccess.others} />
      ) : (
        <div data-component="SourcesError">
          <ErrorState kind="error" details={error} />
        </div>
      )}
    </MobileShell>
  );
}
