/**
 * The middleware renews a session whose upstream token is about to lapse:
 * the handler of this same request must see the new cookie, and the browser
 * must get it back.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AgentHomeSession } from "@/lib/auth/session";

vi.mock("@/lib/apps/guard", () => ({ guardAgentHomeRequest: () => ({ ok: true }) }));
vi.mock("@/lib/http/body-route-guard", () => ({
  roleBlockedApp: async () => null,
  notAvailableForRole: () => null,
}));
vi.mock("@/lib/nav/profile-gate", () => ({ DEFAULT_PROFILE_ONLY_PATH: "/x", gatedToDefaultProfile: () => false }));
const renewSession = vi.fn<(s: AgentHomeSession) => Promise<AgentHomeSession | null>>(async () => null);
vi.mock("@/lib/auth/renew", () => ({ renewSession: (s: AgentHomeSession) => renewSession(s) }));

import { middleware } from "./middleware";
import { deserializeSession, serializeSession, SESSION_COOKIE } from "@/lib/auth/session";

const now = Math.floor(Date.now() / 1000);
const SESSION: AgentHomeSession = {
  hermesToken: "old-at",
  refreshToken: "old-rt",
  expiresAt: now + 30,
  profile: "default",
  principal: { user_id: "u1", display: "U", role: "owner", channels: [], is_owner: true },
  issuedAt: now - 3_570,
};

function request(): NextRequest {
  return new NextRequest("https://home.example/view/f1", {
    headers: { cookie: `${SESSION_COOKIE}=${serializeSession(SESSION)}; other=1` },
  });
}

/** The cookie header Next hands the route handler after the middleware. */
function forwardedCookie(res: Response): string | null {
  return res.headers.get("x-middleware-request-cookie");
}

beforeAll(() => {
  process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
});
beforeEach(() => renewSession.mockReset());

describe("middleware session renewal", () => {
  it("hands the handler and the browser the renewed session", async () => {
    renewSession.mockImplementation(async (s) => ({ ...s, hermesToken: "new-at", refreshToken: "new-rt", expiresAt: now + 3_600 }));
    const res = await middleware(request());

    expect(renewSession.mock.calls[0][0]).toMatchObject({ hermesToken: "old-at", refreshToken: "old-rt" });
    const sent = res.cookies.get(SESSION_COOKIE);
    expect(deserializeSession(sent?.value)).toMatchObject({ hermesToken: "new-at", refreshToken: "new-rt" });
    expect(sent).toMatchObject({ httpOnly: true, secure: true, path: "/" });
    expect(sent?.maxAge).toBeLessThanOrEqual(12 * 3_600 - 3_570);

    const forwarded = forwardedCookie(res) ?? "";
    const value = /__Host-agent_home_session=([^;]+)/.exec(forwarded)?.[1];
    expect(deserializeSession(value ? decodeURIComponent(value) : undefined)?.hermesToken).toBe("new-at");
    expect(forwarded).toContain("other=1");
  });

  it("changes nothing when there is nothing to renew", async () => {
    const res = await middleware(request());
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(forwardedCookie(res)).toBeNull();
  });
});
