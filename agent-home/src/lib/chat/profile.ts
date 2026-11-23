/**
 * Reading the requested profile off a chat request (FG-28).
 *
 * The chat surface can address any profile this box serves, and a profile is a
 * whole `HERMES_HOME` (SOUL, config, skills, memory, credentials, `state.db`).
 * Every `/api/chat/*` route therefore reads the profile the same way and binds
 * its API client to it — otherwise one forgotten route reads the default
 * profile's sessions while the turn runs in another, which is exactly the
 * mismatch that files one profile's reply in another's history.
 *
 * `"default"` and anything unnamed mean the box's own home. The name is *not*
 * validated here: the Python API owns profile resolution and answers 404 for a
 * profile that does not exist, so a client-side allowlist would only be a
 * second, drifting copy of that rule.
 */

/** Read `?profile=` from a request URL. */
export function profileFromUrl(url: string): string | undefined {
  return clean(new URL(url).searchParams.get("profile"));
}

/**
 * Like `profileFromUrl`, but an explicit `?profile=default` stays `"default"`
 * (the box's own home) instead of falling back to the session's profile.
 */
export function targetProfileFromUrl(url: string): string | undefined {
  const raw = (new URL(url).searchParams.get("profile") ?? "").trim();
  return raw === "default" ? "default" : clean(raw);
}

/**
 * Like `profileFromBody`, but an explicit `"default"` stays `"default"`: the
 * project chat can pick the box's own home while the console sits in another
 * profile, and every call of that conversation must address the same home.
 */
export function targetProfileFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { profile?: unknown }).profile;
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "default" ? "default" : clean(value);
}

/** Read `profile` from an already-parsed JSON body. */
export function profileFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { profile?: unknown }).profile;
  return clean(typeof raw === "string" ? raw : null);
}

function clean(raw: string | null): string | undefined {
  const value = (raw ?? "").trim();
  return value && value !== "default" ? value : undefined;
}

/**
 * Add the selected profile to a BFF path (browser side). The counterpart of
 * `profileFromUrl`: what the chat pane calls so a read lands on the same
 * profile as the turn.
 */
export function withProfileQuery(path: string, profile: string | undefined): string {
  const name = clean(profile ?? null);
  if (!name) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}profile=${encodeURIComponent(name)}`;
}

/** Like `withProfileQuery`, but an explicit `default` is kept (see `targetProfileFromBody`). */
export function withTargetProfileQuery(path: string, profile: string | undefined): string {
  if ((profile ?? "").trim() !== "default") return withProfileQuery(path, profile);
  return `${path}${path.includes("?") ? "&" : "?"}profile=default`;
}

/** Add the selected profile to a BFF JSON body (browser side). */
export function withProfileBody<T extends object>(
  body: T,
  profile: string | undefined,
): T & { profile?: string } {
  const name = clean(profile ?? null);
  return name ? { ...body, profile: name } : body;
}
