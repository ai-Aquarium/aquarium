import { MobileShell } from "@/components/MobileShell";
import { AddDataSource } from "@/components/data/AddDataSource";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";

export const dynamic = "force-dynamic";

/** Add data source: a website (continues in Sites) or a database you connect. Anyone may connect one, private to them. */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("data");
  let canAddSite = false;
  try {
    canAddSite = (await (await apiClientForRequest()).siteSettings()).can_create;
  } catch {
    canAddSite = false;
  }
  return (
    <MobileShell title={t("add.title")} subtitle={t("add.subtitle")} wide>
      <AddDataSource canAddSite={canAddSite} isOwner={principal.is_owner} isAdmin={principal.is_owner || principal.role === "admin"} />
    </MobileShell>
  );
}
