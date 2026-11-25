"use client";

/**
 * POST a small JSON mutation to a same-origin BFF route. Returns `null` on
 * success or a one-line problem for inline display — for actions whose card
 * disappears on success, so there is no page to land on.
 */
export async function post(path: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (res.ok) return null;
    const parsed = (await res.json().catch(() => null)) as { detail?: string } | null;
    return parsed?.detail ?? "That didn't go through.";
  } catch {
    return "Couldn't reach Aquarium. Try again.";
  }
}
