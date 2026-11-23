import { describe, expect, it } from "vitest";

import {
  profileFromBody,
  profileFromUrl,
  withProfileBody,
  withProfileQuery,
} from "@/lib/chat/profile";

describe("chat profile plumbing", () => {
  it("reads a named profile from the URL and the body", () => {
    expect(profileFromUrl("http://x/api/chat/sessions?profile=maintenance")).toBe(
      "maintenance",
    );
    expect(profileFromBody({ profile: "maintenance" })).toBe("maintenance");
  });

  it("treats the default profile and the unnamed case identically", () => {
    // The box's own home needs no scope; carrying "default" would make every
    // single-profile request look like a cross-profile one.
    for (const url of [
      "http://x/api/chat/sessions",
      "http://x/api/chat/sessions?profile=",
      "http://x/api/chat/sessions?profile=default",
      "http://x/api/chat/sessions?profile=%20%20",
    ]) {
      expect(profileFromUrl(url)).toBeUndefined();
    }
    expect(profileFromBody({})).toBeUndefined();
    expect(profileFromBody({ profile: "default" })).toBeUndefined();
    expect(profileFromBody(null)).toBeUndefined();
    expect(profileFromBody({ profile: 7 })).toBeUndefined();
  });

  it("round-trips a profile through a query string", () => {
    expect(withProfileQuery("/api/chat/sessions", "maintenance")).toBe(
      "/api/chat/sessions?profile=maintenance",
    );
    expect(
      profileFromUrl(
        `http://x${withProfileQuery("/api/chat/sessions?archived=only", "p 1")}`,
      ),
    ).toBe("p 1");
    expect(withProfileQuery("/api/chat/sessions", "default")).toBe(
      "/api/chat/sessions",
    );
  });

  it("round-trips a profile through a JSON body without dropping fields", () => {
    const body = withProfileBody({ sessionId: "s1", title: "t" }, "maintenance");
    expect(body).toEqual({ sessionId: "s1", title: "t", profile: "maintenance" });
    expect(profileFromBody(body)).toBe("maintenance");
    expect(withProfileBody({ sessionId: "s1" }, undefined)).toEqual({
      sessionId: "s1",
    });
  });
});

describe("explicit default (project chat)", () => {
  it("keeps default where the plain readers fall back to the console profile", async () => {
    const { targetProfileFromBody, withTargetProfileQuery } = await import("./profile");
    expect(targetProfileFromBody({ profile: "default" })).toBe("default");
    expect(targetProfileFromBody({ profile: "finance" })).toBe("finance");
    expect(targetProfileFromBody({})).toBeUndefined();
    expect(withTargetProfileQuery("/api/chat/active?sessionId=s", "default")).toBe(
      "/api/chat/active?sessionId=s&profile=default",
    );
    expect(withTargetProfileQuery("/x", "finance")).toBe(withProfileQuery("/x", "finance"));
  });
});
