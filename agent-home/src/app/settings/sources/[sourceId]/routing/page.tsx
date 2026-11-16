import { MobileShell } from "@/components/MobileShell";
import { RecentRouting } from "@/components/sources/RecentRouting";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { RoutingDecision, Source } from "@/types";

export const dynamic = "force-dynamic";

const LIMIT = 50;

/** Settings › Sources › Recent routing (FG-03 P7, 4c): the quick check's calls for one source. */
export default async function Page({ params }: { params: Promise<{ sourceId: string }> }) {
  await requirePrincipal();
  const { sourceId } = await params;
  const client = await apiClientForRequest();
  const t = await getT("sources");

  let sources: Source[] = [];
  let decisions: RoutingDecision[] = [];
  let error: string | null = null;
  try {
    const [list, recent] = await Promise.all([
      client.sources(),
      client.sourceDecisions({ sourceId, limit: LIMIT }),
    ]);
    sources = list.sources;
    decisions = recent.decisions;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }
  const known = sources.some((s) => s.source_id === sourceId);

  return (
    <MobileShell
      title={t("routing.title")}
      subtitle={t("routing.subtitle")}
      info={<InfoTip label={t("routing.infoLabel")}>{t("routing.info")}</InfoTip>}
      wide
    >
      {error ? (
        <div data-component="RecentRoutingError">
          <ErrorState kind="error" details={error} />
        </div>
      ) : !known ? (
        <ErrorState kind="error" details={t("routing.unknownSource")} />
      ) : (
        <RecentRouting sources={sources} sourceId={sourceId} decisions={decisions} limit={LIMIT} />
      )}
    </MobileShell>
  );
}
