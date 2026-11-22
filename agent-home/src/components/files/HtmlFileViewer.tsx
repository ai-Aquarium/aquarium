"use client";

import { useState } from "react";

import { HtmlViewerActions } from "@/components/files/HtmlViewerActions";
import { InfoIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { useT } from "@/i18n";

/**
 * No `allow-same-origin`: the page gets an opaque origin, so its script runs
 * without agent-home's cookies, storage or API. The response repeats this as
 * a CSP sandbox (`HTML_VIEW_CSP`), which also covers Open in new tab.
 */
export const VIEWER_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** Figma "Inner — HTML page viewer": the agent's page in an isolated frame. */
export function HtmlFileViewer({ id, title }: { id: string; title: string }) {
  const t = useT("fileViewer");
  const [loaded, setLoaded] = useState(false);
  return (
    <div data-component="HtmlFileViewer" className="flex min-h-0 flex-1 flex-col gap-3">
      <InlineAlert tone="info" className="hidden sm:flex">
        {t("isolated")}
      </InlineAlert>
      <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] sm:hidden">
        <InfoIcon size={14} />
        {t("isolatedShort")}
      </p>
      <div className="relative flex min-h-[420px] flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white">
        <iframe
          src={`/api/files/${encodeURIComponent(id)}/content?view=1`}
          title={title}
          sandbox={VIEWER_SANDBOX}
          className="h-full w-full flex-1 border-0"
          onLoad={(e) => {
            if (e.currentTarget.getAttribute("src")) setLoaded(true);
          }}
        />
        {!loaded ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-surface)] p-4">
            <PanelLoading label={t("opening")} rows={3} className="w-full max-w-sm" />
          </div>
        ) : null}
      </div>
      <HtmlViewerActions id={id} className="flex sm:hidden" />
    </div>
  );
}
