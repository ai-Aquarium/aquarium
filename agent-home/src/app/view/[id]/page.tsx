import { MobileShell } from "@/components/MobileShell";
import { HtmlFileViewer } from "@/components/files/HtmlFileViewer";
import { HtmlViewerActions } from "@/components/files/HtmlViewerActions";
import { HtmlViewerUnavailable, type ViewerProblem } from "@/components/files/HtmlViewerUnavailable";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { isHtmlFile } from "@/lib/http/file-headers";
import { viewerBack } from "@/lib/nav/viewer-back";
import type { FileAsset } from "@/types";

// Per-principal HTML — never cached.
export const dynamic = "force-dynamic";

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${Math.max(bytes || 0, 0)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `/view/<id>` — a registered HTML file (an agent's interactive chart or
 * report) shown in an isolated frame, with Back, Open in new tab and Download.
 * Not for local apps: those live under `/apps/<slug>` with their own sign-in.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  await requirePrincipal();
  const { id } = await params;
  const { from } = await searchParams;
  const t = await getT("fileViewer");
  const back = viewerBack(from);

  let file: FileAsset | null = null;
  let problem: ViewerProblem | null = null;
  try {
    const client = await apiClientForRequest();
    file = await client.file(id);
    if (!isHtmlFile(file.content_type, file.filename)) problem = "notHtml";
  } catch (err) {
    problem = err instanceof HermesApiError && (err.status === 404 || err.status === 403) ? "missing" : "error";
  }

  const subtitle = file
    ? [t("meta", { size: formatBytes(file.byte_size) }), file.conversation].filter(Boolean).join("  ·  ")
    : undefined;
  const showing = file && !problem;

  return (
    <MobileShell
      title={file?.filename ?? t("title")}
      subtitle={subtitle}
      back={back}
      wide
      fill
      actions={showing ? <HtmlViewerActions id={file!.id} className="hidden sm:flex" /> : null}
    >
      {showing ? (
        <HtmlFileViewer id={file!.id} title={file!.filename} />
      ) : (
        <HtmlViewerUnavailable reason={problem ?? "error"} back={back} downloadId={file?.id ?? null} />
      )}
    </MobileShell>
  );
}
