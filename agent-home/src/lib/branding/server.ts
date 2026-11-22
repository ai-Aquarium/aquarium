import "server-only";

import { HermesApiClient } from "@/lib/api/client";

import { NO_BRANDING, parseBranding, type Branding } from "./branding";

const TTL_MS = 15_000;
let cached: { at: number; value: Branding } | null = null;

/**
 * The box's branding for server rendering (root layout, sign-in page). Read
 * without a session — the sign-in page needs it — and cached briefly so each
 * page render doesn't add a round trip. Never throws: an unreachable API
 * means the Aquarium defaults.
 */
export async function getBranding(): Promise<Branding> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  let value: Branding;
  try {
    value = parseBranding(await new HermesApiClient().branding());
  } catch {
    value = cached?.value ?? NO_BRANDING;
  }
  cached = { at: Date.now(), value };
  return value;
}

/** After an owner's change: serve the new branding at once. */
export function rememberBranding(value: unknown): Branding {
  const parsed = parseBranding(value);
  cached = { at: Date.now(), value: parsed };
  return parsed;
}

/** Tests only. */
export function resetBrandingCache(): void {
  cached = null;
}
