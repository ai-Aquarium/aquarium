import Link from "next/link";

import { MobileShell } from "@/components/MobileShell";
import { DataList } from "@/components/data/DataList";
import { siteHealth } from "@/components/data/format";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import type { HermesApiClient } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { DataSource } from "@/types/data";

import { loadDirectory } from "../sites/data";

export const dynamic = "force-dynamic";

/** Site sources take their health from the site's last refresh run; unreadable runs leave it unset. */
async function withSiteHealth(client: HermesApiClient, sources: DataSource[]): Promise<DataSource[]> {
  return Promise.all(
    sources.map(async (s) => {
      if (s.kind !== "site" || !s.site_id || s.health) return s;
      try {
        const { runs } = await client.siteRuns(s.site_id);
        return { ...s, health: siteHealth(runs[0] ?? null) };
      } catch {
        return s;
      }
    }),
  );
}

/** **Data** (plan 2026-11-14-001): every data source — websites, Aquarium data, connected databases. Hermes filters by access. */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("data");
  let sources: DataSource[] | null = null;
  let people: Record<string, string> = {};
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const [doc, directory] = await Promise.all([client.dataSources(), loadDirectory(client)]);
    sources = await withSiteHealth(client, doc.sources);
    people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load data sources";
  }
  return (
    <MobileShell
      title={t("title")}
      subtitle={t("subtitle")}
      info={<InfoTip label={t("info")}>{t("infoBody")}</InfoTip>}
      wide
      actions={
        <Link href="/data/new" className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)]">
          {t("list.add")}
        </Link>
      }
    >
      {sources === null ? (
        <ErrorState kind="error" details={error} />
      ) : (
        <>
          <DataList sources={sources} people={people} me={principal.user_id} />
          <p className="mt-3 text-[13px] text-[var(--color-muted)]">
            {t("list.footSites")}{" "}
            <Link href="/sites" className="font-medium text-[var(--color-accent)] hover:underline">
              {t("list.footSitesLink")}
            </Link>
            {" · "}
            {t("list.footVpn")}{" "}
            <Link href="/settings/in-out" className="font-medium text-[var(--color-accent)] hover:underline">
              {t("list.footVpnLink")}
            </Link>
          </p>
        </>
      )}
    </MobileShell>
  );
}
