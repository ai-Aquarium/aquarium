/**
 * File-content route tests — the fix for "error loading" on every device.
 *
 * The Python layer signs a URL that names Supabase as the *server* reaches it
 * (`http://127.0.0.1:8000` on the box, not publicly exposed). Redirecting to it
 * sent the browser to its own loopback, so the route must fetch the bytes and
 * pipe them, forwarding `Range` so video seeking keeps working.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/files/[id]/content/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const fileLink = vi.fn(async (id: string, download: boolean) => ({
  url: `http://127.0.0.1:8000/storage/v1/object/sign/bucket/${id}?token=t&dl=${download}`,
  expires_in: 300,
  filename: "vid_a719.mp4",
  content_type: "video/mp4",
}));

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ fileLink }),
}));

function get(
  id: string,
  { query = "", headers = {} }: { query?: string; headers?: HeadersInit } = {},
): Promise<Response> {
  return GET(
    new Request(`http://home.test/api/files/${id}/content${query}`, { headers }),
    { params: Promise.resolve({ id }) },
  ) as unknown as Promise<Response>;
}

describe("GET /api/files/:id/content", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo_owner",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response("bytes", {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "5",
          etag: '"abc"',
        },
      }),
    );
  });

  it("401s an unauthenticated request without asking for a link", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await get("f1")).status).toBe(401);
    expect(fileLink).not.toHaveBeenCalled();
  });

  it("streams the bytes instead of redirecting to the signed URL", async () => {
    const res = await get("f1");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toContain("inline");
    await expect(res.text()).resolves.toBe("bytes");
    expect(fetchMock.mock.calls[0][0]).toContain("127.0.0.1:8000");
  });

  it("forwards Range and passes the partial response back", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("yt", {
        status: 206,
        headers: { "content-range": "bytes 0-1/5", "content-type": "video/mp4" },
      }),
    );
    const res = await get("f1", { headers: { range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1/5");
    const sent = new Headers(
      (fetchMock.mock.calls[0][1] as RequestInit).headers as HeadersInit,
    );
    expect(sent.get("range")).toBe("bytes=0-1");
  });

  it("asks for a download disposition on ?download=1", async () => {
    const res = await get("f1", { query: "?download=1" });
    expect(fileLink).toHaveBeenCalledWith("f1", true);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("vid_a719.mp4");
  });

  it("never serves sender-supplied HTML or SVG inline on this origin", async () => {
    for (const type of ["text/html", "image/svg+xml"]) {
      fetchMock.mockResolvedValueOnce(
        new Response("<svg onload=alert(1)>", { status: 200, headers: { "content-type": type } }),
      );
      const res = await get("f1");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
  });

  it("sandboxes inline-safe types too", async () => {
    const res = await get("f1");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });

  it("502s when the AI layer is unreachable", async () => {
    fileLink.mockRejectedValueOnce(new Error("boom"));
    expect((await get("f1")).status).toBe(502);
  });

  describe("HTML pages", () => {
    const html = () =>
      new Response("<html><head></head><body><script>x()</script></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    beforeEach(() => {
      fileLink.mockResolvedValue({
        url: "http://127.0.0.1:8000/sign/chart.html?token=t",
        expires_in: 300,
        filename: "chart.html",
        content_type: "text/html",
      });
      fetchMock.mockImplementation(async () => html());
    });

    it("sends a browser opening the plain link to the viewer", async () => {
      const res = await get("f 1", { headers: { "sec-fetch-dest": "document" } });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/view/f%201");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still downloads on ?download=1 and when fetched by a script", async () => {
      for (const [query, headers] of [
        ["?download=1", { "sec-fetch-dest": "document" }],
        ["", {}],
      ] as const) {
        const res = await get("f1", { query, headers });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
        expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
      }
    });

    it("serves ?view=1 inline with script allowed but an opaque origin", async () => {
      const res = await get("f1", { query: "?view=1", headers: { "sec-fetch-dest": "iframe", range: "bytes=0-1" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toMatch(/^sandbox allow-scripts /);
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).toContain("connect-src 'none'");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const body = await res.text();
      expect(body).toContain("<script>x()</script>");
      expect(body).toContain('a.target="_blank"');
      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("range")).toBeNull();
    });

    it("never runs a non-HTML file through ?view=1", async () => {
      fileLink.mockResolvedValueOnce({
        url: "http://127.0.0.1:8000/sign/x.svg",
        expires_in: 300,
        filename: "x.svg",
        content_type: "image/svg+xml",
      });
      const res = await get("f1", { query: "?view=1" });
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    });
  });
});
