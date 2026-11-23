import { describe, expect, it } from "vitest";

import { readUpstreamTokens } from "@/lib/auth/upstream-tokens";

describe("readUpstreamTokens", () => {
  it("keeps the access token, its expiry and the refresh token", () => {
    const tokens = readUpstreamTokens(
      [
        "hermes_session_at=eyJ.a%2Bb; HttpOnly; Max-Age=3600; Path=/; SameSite=lax",
        "hermes_session_rt=rt-1; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax",
      ],
      1_000,
    );
    expect(tokens).toEqual({ hermesToken: "eyJ.a+b", refreshToken: "rt-1", expiresAt: 4_600 });
  });

  it("reads prefixed cookie names", () => {
    const tokens = readUpstreamTokens(["__Host-hermes_session_at=at; Max-Age=60", "__Secure-hermes_session_rt=rt"], 0);
    expect(tokens).toEqual({ hermesToken: "at", refreshToken: "rt", expiresAt: 60 });
  });

  it("is an access-token-only session when the provider issues no refresh token", () => {
    expect(readUpstreamTokens(["hermes_session_at=at; Path=/"])).toEqual({ hermesToken: "at" });
  });

  it("is null without an access token", () => {
    expect(readUpstreamTokens(["hermes_session_rt=rt", "other=1"])).toBeNull();
  });

  it("does not take another cookie whose name ends the same way", () => {
    expect(readUpstreamTokens(["x_hermes_session_at=bad"])).toBeNull();
  });
});
