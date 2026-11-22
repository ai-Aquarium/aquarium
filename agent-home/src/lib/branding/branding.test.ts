import { describe, expect, it } from "vitest";

import { brandName, brandingLogoSrc, monogramFor, NO_BRANDING, parseBranding } from "./branding";

describe("monogramFor", () => {
  it.each([
    ["Leo Lau", "LL"],
    ["HangSengDev", "H"],
    ["hang seng dev", "HS"],
    ["Reef-team", "RT"],
    ["acme", "A"],
    ["Q", "Q"],
    ["恒生", "恒"],
    ["  ", ""],
    [null, ""],
  ])("%s → %s", (name, expected) => {
    expect(monogramFor(name)).toBe(expected);
  });
});

describe("branding helpers", () => {
  it("falls back to Aquarium and has no logo URL without branding", () => {
    expect(brandName(NO_BRANDING)).toBe("Aquarium");
    expect(brandingLogoSrc(NO_BRANDING)).toBeNull();
  });

  it("versions the logo URL so a new upload busts caches", () => {
    const b = { name: "HangSengDev", logo: { content_type: "image/png", version: "abc123" } };
    expect(brandName(b)).toBe("HangSengDev");
    expect(brandingLogoSrc(b)).toBe("/api/branding/logo?v=abc123");
  });

  it("parses only well-formed API answers", () => {
    expect(parseBranding({ name: " Leo Lau ", logo: null })).toEqual({ name: "Leo Lau", logo: null });
    expect(parseBranding({ name: "", logo: { content_type: "image/svg+xml", version: "x" } })).toEqual(NO_BRANDING);
    expect(parseBranding("nope")).toEqual(NO_BRANDING);
    expect(parseBranding({ name: "H", logo: { content_type: "image/webp", version: "v1" } }).logo).toEqual({
      content_type: "image/webp",
      version: "v1",
    });
  });
});
