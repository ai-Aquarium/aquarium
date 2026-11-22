import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  hermesApiBaseUrl: () => "http://api",
}));

import { GET } from "./route";

let upstream: () => Response;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => upstream()));
});

describe("GET /api/branding/logo", () => {
  it("serves the logo bytes without sign-in, as an inert image", async () => {
    upstream = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("is a 404 when none is set or the type is not a raster image", async () => {
    upstream = () => Response.json({ detail: "No logo is set." }, { status: 404 });
    expect((await GET()).status).toBe(404);
    upstream = () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    expect((await GET()).status).toBe(404);
  });
});
