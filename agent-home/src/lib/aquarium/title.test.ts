import { describe, expect, it } from "vitest";

import { NO_BRANDING } from "@/lib/branding/branding";

import { AQUARIUM_NAME_DEFAULT } from "./creatures";
import { aquariumTitle } from "./title";

const HSD = { name: "HangSengDev", logo: { content_type: "image/png", version: "v1" } };
const UNSET = { name: AQUARIUM_NAME_DEFAULT, name_is_default: true };

describe("aquariumTitle", () => {
  it("uses the owner's own Aquarium name over the box name", () => {
    expect(aquariumTitle({ name: "HSD Ops Reef", name_is_default: false }, HSD)).toBe("HSD Ops Reef");
  });

  it("keeps a name set to exactly “Aquarium” on purpose", () => {
    expect(aquariumTitle({ name: AQUARIUM_NAME_DEFAULT, name_is_default: false }, HSD)).toBe(AQUARIUM_NAME_DEFAULT);
  });

  it("falls back to the box name when no Aquarium name is set", () => {
    expect(aquariumTitle(UNSET, HSD)).toBe("HangSengDev");
    expect(aquariumTitle(UNSET, { name: "Leo Lau", logo: null })).toBe("Leo Lau");
  });

  it("is “Aquarium” when neither is set", () => {
    expect(aquariumTitle(UNSET, NO_BRANDING)).toBe(AQUARIUM_NAME_DEFAULT);
  });
});
