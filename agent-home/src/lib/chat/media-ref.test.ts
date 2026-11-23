import { describe, expect, it } from "vitest";

import {
  mediaDownloadRef,
  mediaFileName,
  mediaRef,
  mediaRefPath,
} from "@/lib/chat/media-ref";

describe("media refs", () => {
  it("round-trips an object path through the BFF read route", () => {
    const path = "leo_owner/home_1/abc-photo.png";
    const ref = mediaRef(path);
    expect(ref.startsWith("/api/chat/media?path=")).toBe(true);
    expect(ref).not.toContain(" ");
    expect(mediaRefPath(ref)).toBe(path);
  });

  it("never emits a bucket or signed URL", () => {
    expect(mediaRef("u/s/a.png")).not.toContain("http");
  });

  it("returns null for a plain external URL", () => {
    expect(mediaRefPath("https://cdn.test/a.png")).toBeNull();
    expect(mediaRefPath("/api/chat/messages?sessionId=1")).toBeNull();
  });
});

describe("mediaFileName", () => {
  it("strips the writer's uniqueness prefix from the last segment", () => {
    expect(mediaFileName("u/files/ab/0123456789abcdef-chart.png")).toBe("chart.png");
    expect(
      mediaFileName("u/home_1/3f2a9c1e-1b2c-4d5e-8f90-0123456789ab-report.pdf"),
    ).toBe("report.pdf");
  });

  it("keeps a name that has no such prefix", () => {
    expect(mediaFileName("u/s/my-chart.png")).toBe("my-chart.png");
    expect(mediaFileName("u/s/0123456789abcdef-")).toBe("0123456789abcdef-");
  });

  it("names the download URL for the same object", () => {
    const path = "u/files/ab/0123456789abcdef-chart.png";
    expect(mediaDownloadRef(path)).toBe(
      `/api/chat/media/content?path=${encodeURIComponent(path)}&download=1`,
    );
  });
});
