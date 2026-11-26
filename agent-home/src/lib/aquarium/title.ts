import { brandName, type Branding } from "@/lib/branding/branding";

import type { AquariumSnapshot } from "./creatures";

/**
 * The dashboard's title: the owner's own Aquarium name (Settings → Aquarium)
 * if they set one, else the box name (Settings → Name and logo), else
 * "Aquarium".
 */
export function aquariumTitle(snapshot: Pick<AquariumSnapshot, "name" | "name_is_default">, branding: Branding): string {
  return snapshot.name_is_default ? brandName(branding) : snapshot.name;
}
