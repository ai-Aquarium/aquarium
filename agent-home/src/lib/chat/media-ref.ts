/**
 * The durable in-transcript reference to a private-bucket media object
 * (FG-20 multi-user PR-5).
 *
 * A persisted turn can never carry a usable media URL: the bucket is private,
 * so a public URL would break isolation and a signed URL would expire. Instead
 * the transcript carries the **object path** wrapped in the BFF read route
 * (`/api/chat/media?path=…`), which re-signs on demand after checking that the
 * caller owns the path. This module is the single place that shape is built and
 * parsed, shared by the send route (writer) and the chat thread (reader).
 */

/** Route the browser fetches a signed URL from. */
export const MEDIA_ROUTE = "/api/chat/media";

/**
 * Route that streams the object's bytes. The browser never gets the signed URL
 * itself: it names Supabase as the *server* reaches it (loopback on the box),
 * so only this BFF-hosted URL is loadable from a phone or laptop.
 */
export const MEDIA_CONTENT_ROUTE = "/api/chat/media/content";

/** A file name made safe as Markdown link text: `\ [ ] ( )` are escaped. */
export function escapeLinkLabel(name: string): string {
  return name.replace(/[\\[\]()]/g, (c) => `\\${c}`);
}

/** The file name in link text, escaped or (turns stored before) not. */
export function unescapeLinkLabel(label: string): string {
  return label.replace(/\\([\\[\]()])/g, "$1");
}

/** The link a turn carries for an attached file: `![name](ref)` for an
 * image (shown inline), `[name](ref)` for anything else (a download chip). */
export function attachmentLink(name: string, path: string, image: boolean): string {
  return `${image ? "!" : ""}[${escapeLinkLabel(name)}](${mediaRef(path)})`;
}

/** The in-transcript reference for one object path. */
export function mediaRef(path: string, project?: string): string {
  return `${MEDIA_ROUTE}?path=${encodeURIComponent(path)}${projectParam(project)}`;
}

/** The loadable URL for one object path. */
export function mediaContentRef(path: string, project?: string): string {
  return `${MEDIA_CONTENT_ROUTE}?path=${encodeURIComponent(path)}${projectParam(project)}`;
}

/**
 * `&project=<slug>`: the file was attached in that project's group chat, so
 * anyone on the project may open it, not only its sender.
 */
function projectParam(project?: string): string {
  return project ? `&project=${encodeURIComponent(project)}` : "";
}

/**
 * The object path a media reference points at, or null when `value` is not one
 * (e.g. a plain external URL in an older transcript).
 */
export function mediaRefPath(value: string): string | null {
  if (!value.startsWith(`${MEDIA_ROUTE}?`)) return null;
  const query = value.slice(`${MEDIA_ROUTE}?`.length);
  const path = new URLSearchParams(query).get("path");
  return path || null;
}

/** The content URL that always downloads (`Content-Disposition: attachment`). */
export function mediaDownloadRef(path: string, project?: string): string {
  return `${mediaContentRef(path, project)}&download=1`;
}

/**
 * The human file name inside an object key: the last segment without the
 * uniqueness prefix the writers add — `<16hex>-` (Python file registry,
 * `<user>/files/<2hex>/<16hex>-<name>`) or `<uuid>-` (chat uploads,
 * `<user>/<session>/<uuid>-<name>`).
 */
export function mediaFileName(path: string): string {
  const last = path.split("/").pop() || "";
  const name = last.replace(
    /^(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(?=.)/i,
    "",
  );
  return name || "file";
}
