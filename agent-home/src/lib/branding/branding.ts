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

/** Up to two letters for the default logo: "Leo Lau" → "LL", "HangSengDev" → "HS". */
export function monogramFor(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/[\s\-_.·]+/u).filter(Boolean);
  if (words.length === 0) return "";
  const first = (w: string) => Array.from(w)[0];
  if (words.length >= 2) return (first(words[0]) + first(words[1])).toLocaleUpperCase();
  const chars = Array.from(words[0]);
  const capitals = chars.filter((c) => c !== c.toLocaleLowerCase());
  if (capitals.length >= 2) return capitals.slice(0, 2).join("");
  // A script without letter case (e.g. Chinese) reads best as one character.
  if (chars[0].toLocaleUpperCase() === chars[0].toLocaleLowerCase()) return chars[0];
  return chars.slice(0, 2).join("").toLocaleUpperCase();
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
