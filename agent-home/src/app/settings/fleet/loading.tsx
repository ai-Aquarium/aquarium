import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/**
 * Route-level loading UI for **Fleet**: the page header paints on tap with a
 * skeleton while the server asks each managed box what it runs.
 */
export default async function Loading() {
  const t = await getT("fleet");
  return (
    <MobileShell title={t("title")}>
      <PageSkeleton rows={3} />
    </MobileShell>
  );
}
