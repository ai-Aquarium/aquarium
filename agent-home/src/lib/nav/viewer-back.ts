import { routeTrail, type Crumb } from "@/lib/nav/route-trail";

/**
 * Where the HTML viewer's Back goes: the in-app page the viewer was opened
 * from (`?from=/chat?session=…`), else Files. Only a relative agent-home page
 * path is accepted, never another site, an API route or another viewer.
 */
export function viewerBack(from: string | null | undefined): Crumb {
  if (
    from &&
    from.length <= 512 &&
    /^\/(?![/\\])/.test(from) &&
    ![...from].some((c) => c < " " || c === "\\") &&
    !/^\/(api|view)(\/|\?|#|$)/.test(from)
  ) {
    const trail = routeTrail(from);
    return { href: from, label: trail[trail.length - 1]?.label ?? "Back" };
  }
  return { href: "/files", label: "Files" };
}

/** The file id of an in-app viewer link (`/view/<id>`), else null. */
export function viewerFileId(href: string | null | undefined): string | null {
  const m = /^\/view\/([^/?#]+)(?:[?#]|$)/.exec(href ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** `/view/<id>`, with `from` when the opener's page is known. */
export function viewerHref(id: string, from?: string | null): string {
  const base = `/view/${encodeURIComponent(id)}`;
  return from ? `${base}?from=${encodeURIComponent(from)}` : base;
}
