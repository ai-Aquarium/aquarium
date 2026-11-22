import { MobileShell } from "@/components/MobileShell";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { getT } from "@/i18n/server";

/** Route-level loading UI for the HTML viewer: Figma "Desktop — 1b · Loading". */
export default async function Loading() {
  const t = await getT("fileViewer");
  return (
    <MobileShell title={t("title")} back={{ href: "/files", label: "Files" }} wide fill>
      <div className="flex min-h-[420px] flex-1 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <PanelLoading label={t("opening")} rows={3} className="w-full max-w-sm" />
      </div>
    </MobileShell>
  );
}
