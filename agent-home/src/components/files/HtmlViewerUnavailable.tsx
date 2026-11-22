"use client";

import Link from "next/link";

import { viewerPrimary, viewerSecondary } from "@/components/files/viewerStyles";
import { ChevronLeftIcon, GridIcon } from "@/components/ui/icons";
import { OnceLink } from "@/components/ui/OnceLink";
import { useT } from "@/i18n";
import type { Crumb } from "@/lib/nav/route-trail";

export type ViewerProblem = "missing" | "notHtml" | "error";

/** Figma "Desktop — 1c · Can't open": why, plus Back and (when possible) Download. */
export function HtmlViewerUnavailable({
  reason,
  back,
  downloadId,
}: {
  reason: ViewerProblem;
  back: Crumb;
  downloadId: string | null;
}) {
  const t = useT("fileViewer");
  return (
    <div
      data-component="HtmlViewerUnavailable"
      data-reason={reason}
      className="flex min-h-[420px] flex-1 flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center"
    >
      <GridIcon size={24} className="text-[var(--color-muted)]" />
      <h2 className="text-lg font-semibold">{t("unavailable.title")}</h2>
      <p className="max-w-md text-sm text-[var(--color-muted)]">{t(`unavailable.${reason}`)}</p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <Link href={back.href} data-action="back" className={viewerSecondary}>
          <ChevronLeftIcon size={16} />
          {t("back", { label: back.label })}
        </Link>
        {downloadId ? (
          <OnceLink
            href={`/api/files/${encodeURIComponent(downloadId)}/content?download=1`}
            busyLabel={t("downloading")}
            data-action="download"
            className={viewerPrimary}
          >
            {t("download")}
          </OnceLink>
        ) : null}
      </div>
    </div>
  );
}
