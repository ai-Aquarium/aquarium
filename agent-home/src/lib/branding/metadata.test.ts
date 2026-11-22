import { describe, expect, it } from "vitest";

import { NO_BRANDING } from "./branding";
import { rootMetadata } from "./metadata";

describe("rootMetadata", () => {
  it("keeps the Aquarium title and icons without branding", () => {
    const meta = rootMetadata(NO_BRANDING);
    expect(meta.title).toBe("Aquarium");
    expect(JSON.stringify(meta.icons)).toContain("/brand/aquarium-favicon.svg");
  });

  it("uses the box name and logo for the tab", () => {
    const meta = rootMetadata({ name: "HangSengDev", logo: { content_type: "image/jpeg", version: "v1" } });
    expect(meta.title).toBe("HangSengDev");
    expect(meta.icons).toEqual({
      icon: [{ url: "/api/branding/logo?v=v1", type: "image/jpeg" }],
      apple: "/api/branding/logo?v=v1",
    });
  });

  it("titles the tab with the name when only a name is set", () => {
    const meta = rootMetadata({ name: "Leo Lau", logo: null });
    expect(meta.title).toBe("Leo Lau");
    expect(JSON.stringify(meta.icons)).toContain("/favicon.ico");
  });
});
