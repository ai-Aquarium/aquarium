import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    has: (name: string) => jar.has(name),
    set: () => {},
  })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  hermesApiBaseUrl: () => "http://api",
}));

import { SESSION_COOKIE, serializeSession } from "@/lib/auth/session";
import { getBranding, resetBrandingCache } from "@/lib/branding/server";

import { DELETE, PUT as PUT_LOGO } from "./logo/route";
import { PUT } from "./route";

const seen: { url: URL; init: RequestInit | undefined }[] = [];
let upstream: () => Response = () => Response.json({});
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  seen.push({ url: new URL(String(url)), init });
  return upstream();
});

function signIn(role: "owner" | "admin" | "member") {
  jar.set(
    SESSION_COOKIE,
    serializeSession({
      hermesToken: "tok",
      profile: "default",
      principal: { user_id: "u1", display: "U", role, channels: [], is_owner: role === "owner" },
      issuedAt: 1_700_000_000,
    }),
  );
}

const putName = (body: unknown) =>
  new Request("http://x/api/settings/branding", { method: "PUT", body: JSON.stringify(body) });

function putLogo(file: File | null) {
  const form = new FormData();
  if (file) form.append("file", file);
  return new Request("http://x/api/settings/branding/logo", { method: "PUT", body: form });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeAll(() => {
  process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
});
beforeEach(() => {
  jar.clear();
  seen.length = 0;
  upstream = () => Response.json({});
  vi.stubGlobal("fetch", fetchMock);
  resetBrandingCache();
});

describe("PUT /api/settings/branding", () => {
  it("is owner only", async () => {
    expect((await PUT(putName({ name: "Leo Lau" }))).status).toBe(401);
    for (const role of ["admin", "member"] as const) {
      signIn(role);
      expect((await PUT(putName({ name: "Leo Lau" }))).status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("validates, forwards and serves the new name at once", async () => {
    signIn("owner");
    expect((await PUT(putName({ name: 3 }))).status).toBe(400);
    expect((await PUT(putName({ name: "x".repeat(61) }))).status).toBe(400);
    upstream = () => Response.json({ name: "Leo Lau", logo: null });
    const res = await PUT(putName({ name: "Leo Lau" }));
    expect(res.status).toBe(200);
    expect(seen.at(-1)?.url.pathname).toBe("/api/settings/branding");
    expect(seen.at(-1)?.url.search).toBe("");
    expect(JSON.parse(String(seen.at(-1)?.init?.body))).toEqual({ name: "Leo Lau" });
    const calls = seen.length;
    expect(await getBranding()).toEqual({ name: "Leo Lau", logo: null });
    expect(seen).toHaveLength(calls);
  });
});

describe("/api/settings/branding/logo", () => {
  it("is owner only", async () => {
    signIn("admin");
    expect((await PUT_LOGO(putLogo(new File([PNG], "l.png", { type: "image/png" })))).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuses a missing, non-image or oversized file", async () => {
    signIn("owner");
    expect((await PUT_LOGO(putLogo(null))).status).toBe(400);
    expect((await PUT_LOGO(putLogo(new File(["<svg/>"], "l.svg", { type: "image/svg+xml" })))).status).toBe(400);
    const big = new File([new Uint8Array(1024 * 1024 + 1)], "l.png", { type: "image/png" });
    expect((await PUT_LOGO(putLogo(big))).status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("forwards the image as base64 and resets with DELETE", async () => {
    signIn("owner");
    upstream = () => Response.json({ name: "HangSengDev", logo: { content_type: "image/png", version: "v1" } });
    const res = await PUT_LOGO(putLogo(new File([PNG], "l.png", { type: "image/png" })));
    expect(res.status).toBe(200);
    expect(JSON.parse(String(seen.at(-1)?.init?.body))).toEqual({ data: Buffer.from(PNG).toString("base64") });
    upstream = () => Response.json({ name: "HangSengDev", logo: null });
    expect((await (await DELETE()).json()).logo).toBeNull();
    expect(seen.at(-1)?.init?.method).toBe("DELETE");
  });
});
