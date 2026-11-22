/**
 * Box branding: the entity name and logo each box's owner sets in Settings →
 * Name and logo. Shown on the sign-in page and in the top bar so everyone can
 * tell which box they are in. No logo → a monogram from the name; no name →
 * the Aquarium mark and name, as before.
 */

export interface BrandingLogo {
  content_type: string;
  /** Changes whenever the image does, so the URL busts caches. */
  version: string;
}

export interface Branding {
  name: string | null;
  logo: BrandingLogo | null;
}

export const NO_BRANDING: Branding = { name: null, logo: null };
export const BRANDING_NAME_MAX = 60;
export const BRANDING_LOGO_MAX_BYTES = 1024 * 1024;
/** Raster only: an SVG can carry script and the logo is served without sign-in. */
export const BRANDING_LOGO_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const DEFAULT_BRAND_NAME = "Aquarium";
export const BRANDING_OWNER_ONLY = "Only the owner can change this box's name and logo.";

export function isBrandingLogoType(type: string): boolean {
  return (BRANDING_LOGO_TYPES as readonly string[]).includes(type);
}

/** The default logo's letters: the first letter of the first two words ("Leo Lau" → "LL"); one word → one letter ("HangSengDev" → "H"). */
export function monogramFor(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/[\s\-_.·]+/u).filter(Boolean);
  const first = (w: string) => Array.from(w)[0].toLocaleUpperCase();
  return words.slice(0, 2).map(first).join("");
}

export function brandName(branding: Branding): string {
  return branding.name ?? DEFAULT_BRAND_NAME;
}

export function brandingLogoSrc(branding: Branding): string | null {
  return branding.logo ? `/api/branding/logo?v=${encodeURIComponent(branding.logo.version)}` : null;
}

/** Anything from the API → a well-formed `Branding` (unknown shapes become "none"). */
export function parseBranding(raw: unknown): Branding {
  if (!raw || typeof raw !== "object") return NO_BRANDING;
  const { name, logo } = raw as { name?: unknown; logo?: unknown };
  const cleanName = typeof name === "string" && name.trim() ? name.trim() : null;
  let cleanLogo: BrandingLogo | null = null;
  if (logo && typeof logo === "object") {
    const { content_type, version } = logo as { content_type?: unknown; version?: unknown };
    if (typeof content_type === "string" && isBrandingLogoType(content_type) && typeof version === "string" && version) {
      cleanLogo = { content_type, version };
    }
  }
  return { name: cleanName, logo: cleanLogo };
}
