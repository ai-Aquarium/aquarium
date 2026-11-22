"use client";

import type { ReactNode } from "react";

import { GridIcon } from "@/components/ui/icons";
import { OnceLink } from "@/components/ui/OnceLink";
import { useT } from "@/i18n";
import { viewerHref } from "@/lib/nav/viewer-back";

/**
 * A chat link to an agent-made HTML page (`/view/<id>`), drawn as the Figma
 * "html-file-card" chip: Open page (same tab, so the viewer's Back returns to
 * this chat) and Download. Each acts once per click.
 */
export function ViewerLink({ id, children }: { id: string; children: ReactNode }) {
  const t = useT("fileViewer");
  return (
    <span data-component="ViewerLink" className="my-1 inline-flex max-w-full flex-wrap items-center gap-2 align-middle">
      <OnceLink
        href={viewerHref(id)}
        busyLabel={t("opening")}
        holdMs={8000}
        data-action="open-page"
        onClick={(e) => {
          e.currentTarget.href = viewerHref(id, `${window.location.pathname}${window.location.search}`);
        }}
        className="inline-flex max-w-full items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 no-underline hover:border-[var(--color-accent)]"
      >
        <GridIcon size={16} className="shrink-0 text-[var(--color-accent)]" />
        <span className="truncate">{children}</span>
        <span className="shrink-0 font-semibold text-[var(--color-accent)]">{t("openPage")}</span>
      </OnceLink>
      <OnceLink
        href={`/api/files/${encodeURIComponent(id)}/content?download=1`}
        busyLabel={t("downloading")}
        data-action="download"
        className="text-xs text-[var(--color-muted)] underline underline-offset-2"
      >
        {t("download")}
      </OnceLink>
    </span>
  );
}
