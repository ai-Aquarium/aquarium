/**
 * Keeps an agent-home session's upstream access token alive.
 *
 * The bridged token is the provider's access token, which can be far shorter
 * than the 12 h session cookie (self-hosted GoTrue: 1 h). Once it lapses every
 * API call answers 401 and the app signs the user out. So the middleware
 * renews it through `POST /auth/refresh` shortly before `expiresAt`, using the
 * refresh token kept from login, and re-signs the cookie with the rotated pair.
 */
import "server-only";

import { hermesApiBaseUrl } from "@/lib/env";
import type { AgentHomeSession } from "@/lib/auth/session";
import { readUpstreamTokens, type UpstreamTokens } from "@/lib/auth/upstream-tokens";

/** Renew this long before the access token lapses. */
export const RENEW_BEFORE_SECONDS = 5 * 60;

/**
 * A browser fires several requests at once, all carrying the same cookie.
 * Each refresh token is spent once and the result shared, so they don't
 * replay a token the provider has already rotated out.
 */
const SHARE_MS = 60_000;
const inFlight = new Map<string, { at: number; result: Promise<UpstreamTokens | null> }>();

export function needsRenewal(session: AgentHomeSession, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return Boolean(session.refreshToken && session.expiresAt && session.expiresAt - nowSeconds <= RENEW_BEFORE_SECONDS);
}

async function refreshUpstream(refreshToken: string): Promise<UpstreamTokens | null> {
  try {
    const res = await fetch(`${hermesApiBaseUrl()}/auth/refresh`, {
      method: "POST",
      headers: { cookie: `hermes_session_rt=${encodeURIComponent(refreshToken)}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return readUpstreamTokens(res.headers.getSetCookie());
  } catch {
    return null;
  }
}

function sharedRefresh(refreshToken: string): Promise<UpstreamTokens | null> {
  const now = Date.now();
  for (const [key, entry] of inFlight) if (now - entry.at > SHARE_MS) inFlight.delete(key);
  const hit = inFlight.get(refreshToken);
  if (hit) return hit.result;
  const result = refreshUpstream(refreshToken);
  inFlight.set(refreshToken, { at: now, result });
  return result;
}

/**
 * The session with a fresh access token, or null when it needs none or the
 * refresh failed (the request then goes on with the old token; a lapsed one
 * gets the usual 401 and sign-out).
 */
export async function renewSession(session: AgentHomeSession): Promise<AgentHomeSession | null> {
  if (!needsRenewal(session) || !session.refreshToken) return null;
  const tokens = await sharedRefresh(session.refreshToken);
  if (!tokens) return null;
  return {
    ...session,
    hermesToken: tokens.hermesToken,
    refreshToken: tokens.refreshToken ?? session.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}

/** Test hook: forget shared refreshes. */
export function resetRenewals(): void {
  inFlight.clear();
}
