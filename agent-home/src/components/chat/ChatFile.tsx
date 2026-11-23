"use client";

import { useEffect, useState } from "react";

import { useT } from "@/i18n";
import { useMediaProject } from "@/components/chat/MediaProject";
import { mediaDownloadRef, mediaFileName, mediaRef } from "@/lib/chat/media-ref";
import { inlineTypeForName } from "@/lib/http/file-headers";
import { newTabRel } from "@/lib/http/link-rel";
import type { ChatMediaUrlResponse } from "@/types";

/**
 * One inline **non-image** attachment (PDF/DOC/XLS/…) from the private media
 * bucket, rendered as a file chip. Like {@link ChatMedia} it holds only the
 * durable object path and asks the BFF (`GET /api/chat/media?path=…`) for the
 * loadable URL, re-checked against the principal before signing.
 *
 * Types a browser shows safely (PDF, images, text) open in a new tab with a
 * separate Download link; everything else downloads straight away, named
 * after the file rather than its storage key.
 */
export function ChatFile({ path, name }: { path: string; name: string }) {
  const project = useMediaProject();
  const t = useT("fileViewer");
  const [resolved, setResolved] = useState<{
    path: string;
    url: string | null;
    failed: boolean;
  }>({ path, url: null, failed: false });
  const { url, failed } =
    resolved.path === path ? resolved : { url: null, failed: false };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(mediaRef(path, project), { cache: "no-store" });
        const body = (await res.json()) as Partial<ChatMediaUrlResponse>;
        if (!active) return;
        setResolved({
          path,
          url: res.ok && body.url ? body.url : null,
          failed: !res.ok || !body.url,
        });
      } catch {
        if (active) setResolved({ path, url: null, failed: true });
      }
    })();
    return () => {
      active = false;
    };
  }, [path, project]);

  const chip =
    "mt-1 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs";

  if (url) {
    const fileName = mediaFileName(path);
    const opensInline = inlineTypeForName(fileName) !== null;
    const downloadUrl = mediaDownloadRef(path, project);
    return (
      <span data-component="ChatFile" className="inline-flex max-w-full flex-wrap items-center gap-2 align-middle">
        <a
          data-action={opensInline ? "open" : "download"}
          href={opensInline ? url : downloadUrl}
          target="_blank"
          rel={newTabRel(url)}
          download={opensInline ? undefined : fileName}
          className={`${chip} underline underline-offset-2`}
        >
          <span aria-hidden="true">📎</span>
          <span className="truncate">{name}</span>
        </a>
        {opensInline && (
          <a
            data-action="download"
            href={downloadUrl}
            rel={newTabRel(downloadUrl)}
            download={fileName}
            className="mt-1 text-xs text-[var(--color-muted)] underline underline-offset-2"
          >
            {t("download")}
          </a>
        )}
      </span>
    );
  }
  return (
    <span data-component="ChatFile" className={`${chip} text-[var(--color-muted)]`}>
      <span aria-hidden="true">📎</span>
      <span className="truncate">
        {failed ? `${name} — unavailable` : `${name}`}
      </span>
    </span>
  );
}
