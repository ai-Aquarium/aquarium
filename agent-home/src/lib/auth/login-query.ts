/**
 * Query parameters that must never sit in the `/login` URL. A native GET
 * submit of an unhydrated sign-in form (or a hand-made link) puts them there,
 * and from the URL they reach history, access logs and Referer headers.
 */
export const LOGIN_CREDENTIAL_PARAMS = ["username", "password", "code"] as const;

/** `url` without the credential params, or null when it carries none. */
export function stripLoginCredentials(url: URL): URL | null {
  if (!LOGIN_CREDENTIAL_PARAMS.some((p) => url.searchParams.has(p))) return null;
  const clean = new URL(url.href);
  for (const p of LOGIN_CREDENTIAL_PARAMS) clean.searchParams.delete(p);
  return clean;
}

