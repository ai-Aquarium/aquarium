import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/** Route-level loading UI for **Recent routing**. */
export default async function Loading() {
  const t = await getT("sources");
  return (
    <MobileShell title={t("routing.title")} subtitle={t("routing.subtitle")} wide>
      <PageSkeleton rows={5} />
    </MobileShell>
  );
}
