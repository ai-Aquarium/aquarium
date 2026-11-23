/**
 * The tokens a `dashboard_auth` login or refresh hands back as Set-Cookie
 * (`hermes_cli/dashboard_auth/cookies.py`): `hermes_session_at` (the access
 * token, `Max-Age` = its lifetime) and, when the provider issues one,
 * `hermes_session_rt` (the refresh token). The names may carry a `__Host-` /
 * `__Secure-` prefix.
 */
export interface UpstreamTokens {
  hermesToken: string;
  refreshToken?: string;
  /** Unix seconds when the access token lapses, when the cookie said. */
  expiresAt?: number;
}

function cookieNamed(raw: string, name: string): string | null {
  const match = raw.match(new RegExp(`^\\s*(?:__Host-|__Secure-)?${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function readUpstreamTokens(setCookies: string[], nowSeconds = Math.floor(Date.now() / 1000)): UpstreamTokens | null {
  let hermesToken: string | null = null;
  let refreshToken: string | null = null;
  let expiresAt: number | undefined;
  for (const raw of setCookies) {
    const at = cookieNamed(raw, "hermes_session_at");
    if (at) {
      hermesToken = at;
      const maxAge = /;\s*max-age=(\d+)/i.exec(raw);
      if (maxAge) expiresAt = nowSeconds + Number(maxAge[1]);
      continue;
    }
    const rt = cookieNamed(raw, "hermes_session_rt");
    if (rt) refreshToken = rt;
  }
  if (!hermesToken) return null;
  return {
    hermesToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
