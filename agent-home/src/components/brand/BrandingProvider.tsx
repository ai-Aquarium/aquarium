"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { NO_BRANDING, type Branding } from "@/lib/branding/branding";

interface BrandingState {
  branding: Branding;
  setBranding: (next: Branding) => void;
}

const BrandingContext = createContext<BrandingState>({ branding: NO_BRANDING, setBranding: () => {} });

/**
 * The box's branding for every client component, seeded by the root layout's
 * server read. Settings → Name and logo calls `setBranding` after a save so
 * the top bar changes without a reload.
 */
export function BrandingProvider({ initial, children }: { initial: Branding; children: ReactNode }) {
  const [branding, setBranding] = useState(initial);
  useEffect(() => setBranding(initial), [initial]);
  const value = useMemo(() => ({ branding, setBranding }), [branding]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingState {
  return useContext(BrandingContext);
}
