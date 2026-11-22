/**
 * GET /api/files/:id/content — open a registered file.
 *
 * The Python layer mints a short-lived signed URL only after checking the
 * caller may see the file; this route then **streams the bytes through the
 * BFF** rather than redirecting to that URL. The signed URL names Supabase as
 * the server sees it (on the box, loopback `127.0.0.1:8000`, which is not
 * exposed publicly), so a redirect hands the browser an address it cannot
 * reach. Piping also keeps the storage host and the signed token server-side,
 * so a stable, per-principal URL is the only thing that ever reaches a page.
 *
 * `?download=1` asks for a download disposition rather than inline viewing.
 * `?view=1` serves an HTML page for the isolated viewer (`/view/<id>`): inline,
 * script allowed, opaque origin (`HTML_VIEW_CSP`). Opening an HTML file's
 * plain link in the browser goes to that viewer instead of downloading.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { isHtmlFile } from "@/lib/http/file-headers";
import { proxyBytes } from "@/lib/http/proxy-bytes";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const download = query.get("download") === "1";
  const view = !download && query.get("view") === "1";
  try {
    const client = await apiClientForRequest();
    const link = await client.fileLink(id, download);
    const html = isHtmlFile(link.content_type, link.filename);
    if (html && !download && !view && req.headers.get("sec-fetch-dest") === "document") {
      return new Response(null, {
        status: 303,
        headers: { location: `/view/${encodeURIComponent(id)}`, "cache-control": "no-store" },
      });
    }
    return await proxyBytes(req, link.url, {
      filename: link.filename,
      download,
      htmlView: view && html,
    });
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
