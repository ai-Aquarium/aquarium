import { describe, expect, it } from "vitest";

import {
  CHECK_IN_CHOICES,
  DEFAULT_CHECK_IN,
  deviceFromHeaders,
  projectHref,
} from "./viewMode";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120.0 Safari/537.36";

describe("device class", () => {
  it("reads phones from the client hint first, then the user agent", () => {
    expect(deviceFromHeaders(MAC, "?1")).toBe("phone");
    expect(deviceFromHeaders(IPHONE, "?0")).toBe("desktop");
    expect(deviceFromHeaders(IPHONE)).toBe("phone");
    expect(deviceFromHeaders(ANDROID)).toBe("phone");
    expect(deviceFromHeaders(MAC)).toBe("desktop");
    expect(deviceFromHeaders(null)).toBe("desktop");
  });
});

describe("check-in picker", () => {
  it("maps each choice onto one autonomy, supervised by default", () => {
    const map = Object.fromEntries(CHECK_IN_CHOICES.map((c) => [c.label, c.autonomy]));
    expect(map).toEqual({
      "Before risky steps": "supervised",
      "Only at the end": "autonomous",
      "Every step": "manual",
    });
    expect(DEFAULT_CHECK_IN).toBe("supervised");
  });
});

describe("projectHref", () => {
  it("opens every project on the one project page", () => {
    expect(projectHref("q3 report")).toBe("/projects/q3%20report");
  });
});
