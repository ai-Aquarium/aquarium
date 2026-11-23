/**
 * FG-33 decision 4: local apps share this origin under `/apps/*` and
 * `/apps-dev/*`, so refuse agent-home requests that an app page made
 * (see `lib/apps/guard.ts`).
 *
 * Settings → Menu: pages and BFF routes of an app hidden from the caller's
 * role are refused here — pages render `/not-available`, APIs answer 403
 * (mapping: `lib/nav/menu-access.ts`). A session in a non-default profile
 * sees only the pages that honour it (`lib/nav/profile-gate.ts`, FG-28).
 *
 * A session whose upstream access token is about to lapse is renewed here
 * first (`lib/auth/renew.ts`): the handler sees the new cookie, and the
 * browser gets it on the response.
 *
 * Upload routes (`BODY_ROUTES` in `lib/http/body-route-guard.ts`) are not
 * matched: running middleware on a streaming request body corrupts it in
 * Next 15.5, so those handlers call `guardBodyRoute` for the same checks.
 */
import { NextResponse, type NextRequest } from "next/server";

import { guardAgentHomeRequest } from "@/lib/apps/guard";
import { stripLoginCredentials } from "@/lib/auth/login-query";
import { notAvailableForRole, roleBlockedApp } from "@/lib/http/body-route-guard";
import { NOT_AVAILABLE_PATH } from "@/lib/nav/menu-access";
import { DEFAULT_PROFILE_ONLY_PATH, gatedToDefaultProfile } from "@/lib/nav/profile-gate";

type Forward = { request: { headers: Headers } } | undefined;

type RenewedCookie = { name: string; value: string; options: Record<string, unknown> };

/** The re-signed session cookie when its upstream token was just renewed. */
async function renewedSessionCookie(request: NextRequest): Promise<RenewedCookie | null> {
  const session = await import("@/lib/auth/session");
  let current;
  try {
    current = session.deserializeSession(session.sessionCookieValue(request.cookies));
  } catch {
    return null;
  }
  if (!current) return null;
  const { renewSession } = await import("@/lib/auth/renew");
  const renewed = await renewSession(current);
  if (!renewed) return null;
  return {
    name: session.SESSION_COOKIE,
    value: session.serializeSession(renewed),
    options: session.renewedCookieOptions(renewed),
  };
}

async function roleGate(request: NextRequest, forward: Forward): Promise<NextResponse | null> {
  const blocked = await roleBlockedApp(request.nextUrl.pathname, request.cookies);
  if (!blocked) return null;
  if (blocked.kind === "api") return notAvailableForRole(blocked.app);
  return NextResponse.rewrite(
    new URL(`${NOT_AVAILABLE_PATH}?app=${encodeURIComponent(blocked.app)}`, request.url),
    forward,
  );
}

/**
 * FG-28 B3: a session working in a non-default profile gets the "default
 * profile only" notice in place of a whole-box page (`lib/nav/profile-gate.ts`).
 */
async function profileGate(request: NextRequest, forward: Forward): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl;
  if (!gatedToDefaultProfile(pathname, "any")) return null;
  const { deserializeSession, sessionCookieValue } = await import("@/lib/auth/session");
  let session;
  try {
    session = deserializeSession(sessionCookieValue(request.cookies));
  } catch {
    return null;
  }
  if (!session || !gatedToDefaultProfile(pathname, session.profile)) return null;
  return NextResponse.rewrite(
    new URL(`${DEFAULT_PROFILE_ONLY_PATH}?from=${encodeURIComponent(pathname)}`, request.url),
    forward,
  );
}

/**
 * `/login?username=…&password=…` (a native GET submit of an unhydrated form, or
 * a hand-made link) is never rendered: the page would echo its own URL in the
 * RSC payload. Redirect to the same URL without them, so history keeps only that.
 */
function loginCredentialRedirect(request: NextRequest): NextResponse | null {
  if (request.nextUrl.pathname !== "/login" || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const clean = stripLoginCredentials(request.nextUrl);
  if (!clean) return null;
  const response = NextResponse.redirect(clean, 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const stripped = loginCredentialRedirect(request);
  if (stripped) return stripped;
  const verdict = guardAgentHomeRequest(request.method, request.nextUrl.pathname, request.headers);
  if (!verdict.ok) {
    return NextResponse.json({ error: "forbidden", detail: verdict.reason }, { status: 403 });
  }
  const renewed = await renewedSessionCookie(request);
  let forward: Forward;
  if (renewed) {
    request.cookies.set(renewed.name, renewed.value);
    forward = { request: { headers: request.headers } };
  }
  const response =
    (await profileGate(request, forward)) ?? (await roleGate(request, forward)) ?? NextResponse.next(forward);
  if (renewed) response.cookies.set(renewed.name, renewed.value, renewed.options);
  return response;
}

export const config = {
  // Node runtime: an edge bundle would also pull instrumentation.ts (undici).
  runtime: "nodejs",
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/chat/upload/?$|api/files/import/?$|api/projects/[^/]+/files/upload/?$).*)",
  ],
};
