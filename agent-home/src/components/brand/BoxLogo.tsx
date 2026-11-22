"use client";

import { useState } from "react";

import { brandingLogoSrc, monogramFor, type Branding } from "@/lib/branding/branding";

import { AquariumMark } from "./AquariumMark";
import { useBranding } from "./BrandingProvider";

/**
 * The box's logo at `size` px: the owner's upload fitted (not cropped) in a
 * rounded white square, else a
 * monogram from the entity name on the accent colour, else the Aquarium mark.
 * Decorative — the name always sits beside it. Pass `branding` to draw a
 * preview instead of the live branding.
 */
export function BoxLogo({ size = 24, branding: override }: { size?: number; branding?: Branding }) {
  const live = useBranding().branding;
  const branding = override ?? live;
  const [failed, setFailed] = useState<string | null>(null);
  const src = brandingLogoSrc(branding);
  const style = { width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.28)) };
  if (src && failed !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- owner upload served by the BFF; not a static asset
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        data-box-logo="image"
        onError={() => setFailed(src)}
        className="shrink-0 bg-white object-contain"
        style={{ ...style, padding: Math.round(size * 0.08) }}
      />
    );
  }
  const monogram = monogramFor(branding.name);
  if (monogram) {
    return (
      <span
        aria-hidden
        data-box-logo="monogram"
        className="inline-flex shrink-0 select-none items-center justify-center bg-[var(--color-accent)] font-bold leading-none tracking-tight text-[var(--color-accent-fg)]"
        style={{ ...style, fontSize: Math.round(size * 0.42) }}
      >
        {monogram}
      </span>
    );
  }
  return <AquariumMark size={size} title="" />;
}
