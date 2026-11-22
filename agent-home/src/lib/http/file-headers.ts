/**
 * Response headers for user- or agent-supplied file bytes served on the
 * agent-home origin (the file, chat-media and project-artifact proxies).
 *
 * The bytes are untrusted: an inbound WhatsApp/email attachment from a
 * stranger, or a file an agent wrote. If `.html`/`.svg` bytes were rendered
 * inline on this origin, their script would run with the viewer's session.
 * So every such response:
 *
 * - sends `nosniff`, so the browser never guesses "this is HTML";
 * - carries a sandboxing CSP, so even a document that does render gets an
 *   opaque origin and no script;
 * - opens inline only for types a browser shows without running script
 *   (raster images, audio/video, PDF, plain text); everything else downloads.
 *
 * `<img>`/`<video>` embeds ignore `Content-Disposition`, so in-app previews
 * keep working for every type.
 */

export const FILE_RESPONSE_CSP =
  "sandbox; default-src 'none'; img-src 'self' data: blob:; " +
  "media-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'";

const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/x-m4a",
  "application/pdf",
  "text/plain",
]);

/** `image/PNG; charset=x` → `image/png`; empty when absent. */
export function essenceOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** Whether a browser may open this type inline on our origin. SVG, HTML,
 *  XML and anything unknown are never inline. */
export function isInlineSafe(contentType: string | null | undefined): boolean {
  return INLINE_SAFE_TYPES.has(essenceOf(contentType));
}

/**
 * The filename is sent both as a quoted ASCII fallback and RFC 5987
 * `filename*`, so non-Latin names survive without breaking older clients.
 */
export function contentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The filename an upstream `Content-Disposition` names, if any. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/.exec(header);
  const value = plain ? (plain[1] ?? plain[2])?.trim() : null;
  return value || null;
}

/**
 * Set the safety headers on `headers` (mutated): `nosniff`, the sandbox CSP,
 * and a `Content-Disposition` that is `inline` only when the caller did not
 * ask to download AND the type is on the safe list. A missing content type
 * becomes `application/octet-stream` so nothing is left to guessing.
 */
export function applyFileSafetyHeaders(
  headers: Headers,
  opts: { filename?: string | null; download?: boolean } = {},
): Headers {
  const type = headers.get("content-type");
  if (!essenceOf(type)) headers.set("content-type", "application/octet-stream");
  const inline = !opts.download && isInlineSafe(type);
  headers.set(
    "content-disposition",
    contentDisposition(inline ? "inline" : "attachment", opts.filename || "file"),
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", FILE_RESPONSE_CSP);
  headers.set("cross-origin-resource-policy", "same-origin");
  return headers;
}

/**
 * The isolated HTML viewer (`/view/<id>`, `?view=1` on the file route): an
 * agent-made page whose script must run (an interactive chart), so it cannot
 * use {@link FILE_RESPONSE_CSP}. `sandbox` without `allow-same-origin` gives
 * the document an opaque origin, so it has no cookies, no storage and no
 * same-origin access to agent-home; `connect-src 'none'` stops fetch/XHR/
 * WebSocket entirely and forms are refused. Scripts, styles and fonts may load
 * from `https:` CDNs (Plotly, Chart.js…). Links leave in a new tab
 * (`allow-popups-to-escape-sandbox` so the opened site works normally).
 */
export const HTML_VIEW_CSP =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; " +
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:; " +
  "style-src 'unsafe-inline' https: data:; img-src https: data: blob:; font-src https: data:; " +
  "media-src https: data: blob:; worker-src blob:; connect-src 'none'; form-action 'none'; " +
  "frame-src 'none'; object-src 'none'; frame-ancestors 'self'";

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const UNTYPED = new Set(["", "application/octet-stream"]);

/** An HTML page: typed as HTML, or untyped with an `.html`/`.htm` name. */
export function isHtmlFile(contentType: string | null | undefined, filename?: string | null): boolean {
  const type = essenceOf(contentType);
  if (HTML_TYPES.has(type)) return true;
  return UNTYPED.has(type) && /\.x?html?$/i.test(filename ?? "");
}

/**
 * Inserted at the top of the page: a click on a link to another page opens
 * it in a new tab, because the viewer's frame may only show this one page.
 * In-page `#anchor` links still scroll.
 */
export const NEW_TAB_LINKS_SCRIPT =
  '<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&' +
  'e.target.closest("a[href]");if(!a||a.target)return;var h=a.getAttribute("href")||"";' +
  'if(h.charAt(0)==="#"||/^javascript:/i.test(h))return;a.target="_blank";a.rel="noopener";},true);</script>';

/** `html` with {@link NEW_TAB_LINKS_SCRIPT} after `<head>` (or `<html>`, or the doctype). */
export function withNewTabLinks(html: string): string {
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + NEW_TAB_LINKS_SCRIPT + html.slice(at);
    }
  }
  return NEW_TAB_LINKS_SCRIPT + html;
}

/** Headers for an HTML page shown in the isolated viewer (mutates `headers`). */
export function applyHtmlViewHeaders(headers: Headers, filename?: string | null): Headers {
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-disposition", contentDisposition("inline", filename || "page.html"));
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", HTML_VIEW_CSP);
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}
