import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { DataSourceDetail } from "@/components/data/DataSourceDetail";
import { isDataTab } from "@/components/data/format";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";


export const dynamic = "force-dynamic";

/** One data source, tabbed (Overview · Dictionary · Access · History · Website/About/Connection). No access is a 404 from Hermes, so it renders as Not found. */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string | string[] }>;
}) {
  const principal = await requirePrincipal();
  const { id } = await params;
  const query = await searchParams;
  const tab = Array.isArray(query?.tab) ? query?.tab[0] : query?.tab;
  const t = await getT("data");
  const client = await apiClientForRequest();
  let loaded;
  try {
    const [doc, versions, directory] = await Promise.all([
      client.dataSource(id),
      client.dataVersions(id),
      client.directory({ limit: 500 }).then((d) => d.entries, () => null),
    ]);
    loaded = { doc, versions: versions.versions, directory };
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 404) notFound();
    return (
      <MobileShell title={t("title")} wide>
        <ErrorState kind="error" details={err instanceof Error ? err.message : String(err)} />
      </MobileShell>
    );
  }
  const name = loaded.doc.source.name;
  return (
    <MobileShell title={name} wide labels={{ [`/data/${id}`]: name }} info={<InfoTip label={t("info")}>{t("infoBody")}</InfoTip>}>
      <DataSourceDetail
        doc={loaded.doc}
        versions={loaded.versions}
        directory={loaded.directory ?? []}
        directoryError={loaded.directory === null}
        me={principal.user_id}
        initialTab={isDataTab(tab) ? tab : "overview"}
      />
    </MobileShell>
  );
}
