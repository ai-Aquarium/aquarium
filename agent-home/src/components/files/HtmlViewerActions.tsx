"use client";

import { viewerSecondary } from "@/components/files/viewerStyles";
import { OnceLink } from "@/components/ui/OnceLink";
import { useT } from "@/i18n";

/** Open in new tab (the same isolated page, full window) and Download. */
export function HtmlViewerActions({ id, className = "" }: { id: string; className?: string }) {
  const t = useT("fileViewer");
  const enc = encodeURIComponent(id);
  return (
    <div data-component="HtmlViewerActions" className={`gap-2 ${className}`}>
      <OnceLink
        href={`/api/files/${enc}/content?view=1`}
        target="_blank"
        rel="noopener"
        busyLabel={t("openingTab")}
        holdMs={2500}
        data-action="open-new-tab"
        className={`${viewerSecondary} flex-1 sm:flex-none`}
      >
        {t("openNewTab")}
      </OnceLink>
      <OnceLink
        href={`/api/files/${enc}/content?download=1`}
        busyLabel={t("downloading")}
        data-action="download"
        className={`${viewerSecondary} flex-1 sm:flex-none`}
      >
        {t("download")}
      </OnceLink>
    </div>
  );
}
