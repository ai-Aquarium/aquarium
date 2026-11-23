import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ hermesApiBaseUrl: () => "http://api" }));

import { needsRenewal, renewSession, resetRenewals, RENEW_BEFORE_SECONDS } from "@/lib/auth/renew";
import type { AgentHomeSession } from "@/lib/auth/session";

const now = () => Math.floor(Date.now() / 1000);

function session(over: Partial<AgentHomeSession> = {}): AgentHomeSession {
  return {
    hermesToken: "old-at",
    refreshToken: "old-rt",
    expiresAt: now() + 60,
    profile: "default",
    principal: { user_id: "u1", display: "U", role: "owner", channels: [], is_owner: true },
    issuedAt: now() - 3_000,
    ...over,
  };
}

const rotated = () =>
  new Response(JSON.stringify({ ok: true, expires_in: 3600 }), {
    headers: [
      ["set-cookie", "hermes_session_at=new-at; HttpOnly; Max-Age=3600; Path=/"],
      ["set-cookie", "hermes_session_rt=new-rt; HttpOnly; Max-Age=2592000; Path=/"],
    ],
  });

const fetchMock = vi.fn(async () => rotated());

beforeEach(() => {
  resetRenewals();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => rotated());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("needsRenewal", () => {
  it("renews only near expiry, and only with a refresh token", () => {
    expect(needsRenewal(session({ expiresAt: now() + RENEW_BEFORE_SECONDS + 60 }))).toBe(false);
    expect(needsRenewal(session({ expiresAt: now() + 10 }))).toBe(true);
    expect(needsRenewal(session({ expiresAt: now() - 10 }))).toBe(true);
    expect(needsRenewal(session({ refreshToken: undefined }))).toBe(false);
    expect(needsRenewal(session({ expiresAt: undefined }))).toBe(false);
  });
});

describe("renewSession", () => {
  it("swaps in the rotated tokens through /auth/refresh", async () => {
    const before = session();
    const after = await renewSession(before);
    expect(after).toMatchObject({ hermesToken: "new-at", refreshToken: "new-rt", profile: "default", issuedAt: before.issuedAt });
    expect(after!.expiresAt).toBeGreaterThanOrEqual(now() + 3_599);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api/auth/refresh");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("cookie")).toBe("hermes_session_rt=old-rt");
  });

  it("spends a refresh token once when requests arrive together", async () => {
    const results = await Promise.all([renewSession(session()), renewSession(session()), renewSession(session())]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r?.hermesToken)).toEqual(["new-at", "new-at", "new-at"]);
  });

  it("does nothing while the token is fresh", async () => {
    expect(await renewSession(session({ expiresAt: now() + 3_000 }))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the session alone when the refresh is refused or unreachable", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ detail: "Session expired" }, { status: 401 }));
    expect(await renewSession(session())).toBeNull();
    resetRenewals();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await renewSession(session())).toBeNull();
  });

  it("keeps the refresh token when the provider does not rotate it", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response("{}", { headers: { "set-cookie": "hermes_session_at=new-at; Max-Age=3600" } }),
    );
    expect(await renewSession(session())).toMatchObject({ hermesToken: "new-at", refreshToken: "old-rt" });
  });
});
