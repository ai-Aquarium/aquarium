/**
 * The message to show for a thrown error. A failed `fetch` rejects with a
 * `TypeError` whose text is browser boilerplate — "Load failed" (Safari),
 * "Failed to fetch" (Chrome), "NetworkError when attempting to fetch
 * resource" (Firefox) — meaningless on its own, so the operation the user
 * was doing leads and the raw text follows in parentheses: e.g.
 * "Failed to load conversation. (Load failed)". Crafted errors (an API
 * `detail`, a thrown `Error`) show their own message.
 */
export function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback;
  return err instanceof TypeError ? `${fallback} (${err.message})` : err.message;
}
