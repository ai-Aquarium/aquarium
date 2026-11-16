import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/** Route-level loading UI for **My sources**: header paints on tap, rows skeleton. */
export default async function Loading() {
  const t = await getT("sources");
  return (
    <MobileShell title={t("title")} subtitle={t("subtitle")} wide>
      <PageSkeleton rows={3} />
    </MobileShell>
  );
}
