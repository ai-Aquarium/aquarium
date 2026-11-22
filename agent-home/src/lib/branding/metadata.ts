import type { Metadata } from "next";

import { brandName, brandingLogoSrc, type Branding } from "./branding";

const AQUARIUM_ICONS: Metadata["icons"] = {
  icon: [
    { url: "/brand/aquarium-favicon.svg", type: "image/svg+xml" },
    { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
    { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
  ],
  apple: "/icons/apple-touch-icon.png",
};

/** The root page metadata: the tab title and icon follow the box's name and logo. */
export function rootMetadata(branding: Branding): Metadata {
  const name = brandName(branding);
  const logo = brandingLogoSrc(branding);
  return {
    title: name,
    description: "Mobile-first face for your Hermes agent.",
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: name },
    icons:
      logo && branding.logo
        ? { icon: [{ url: logo, type: branding.logo.content_type }], apple: logo }
        : AQUARIUM_ICONS,
  };
}
