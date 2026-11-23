/**
 * Chat-media streaming route: the same C2 ownership gate as `/api/chat/media`,
 * plus the piping that makes private media loadable from a browser at all (the
 * signed URL points at the box's loopback Supabase).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/chat/media/content/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const createSignedUrl = vi.fn(async (path: string, ttl: number) => ({
  data: { signedUrl: `http://127.0.0.1:8000/object/sign/${path}?exp=${ttl}` },
  error: null as { message: string } | null,
}));

const projectChatMedia = vi.fn<(slug: string, path: string) => Promise<{ shared: boolean }>>();
vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ projectChatMedia }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ storage: { from: () => ({ createSignedUrl }) } }),
}));

const OWN = "mia_member/home_2/u1-a.png";
const OTHER = "leo_owner/home_1/abc-photo.png";

function get(path: string, extra = ""): Promise<Response> {
  const url = new URL("http://home.test/api/chat/media/content");
  url.searchParams.set("path", path);
  return GET(
    new Request(`${url.toString()}${extra}`),
  ) as unknown as Promise<Response>;
}

describe("GET /api/chat/media/content", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "http://127.0.0.1:8000";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    getPrincipal.mockResolvedValue({
      user_id: "mia_member",
      display: "Mia",
      role: "member",
      channels: [],
      is_owner: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response("png", { status: 200, headers: { "content-type": "image/png" } }),
    );
  });

  it("streams the caller's own object", async () => {
    const res = await get(OWN);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    await expect(res.text()).resolves.toBe("png");
  });

  it("downloads (never renders) an HTML object and sandboxes it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<script>x</script>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const res = await get(OWN);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });

  describe("disposition for agent-made files (<user>/files/<2hex>/<16hex>-<name>)", () => {
    const key = (name: string) => `mia_member/files/ab/0123456789abcdef-${name}`;
    const typed = (type: string) =>
      fetchMock.mockResolvedValueOnce(
        new Response("x", { status: 200, headers: { "content-type": type } }),
      );

    it("opens an image or PDF inline, named after the file not the key", async () => {
      for (const [name, type] of [
        ["chart.png", "image/png"],
        ["report.pdf", "application/pdf"],
      ]) {
        typed(type);
        const res = await get(key(name));
        expect(res.headers.get("content-type")).toBe(type);
        expect(res.headers.get("content-disposition")).toBe(
          `inline; filename="${name}"; filename*=UTF-8''${name}`,
        );
      }
    });

    it("downloads other types with the file's name", async () => {
      typed("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const res = await get(key("Q3-sales.xlsx"));
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="Q3-sales.xlsx"; filename*=UTF-8''Q3-sales.xlsx`,
      );
    });

    it("types an untyped image by its extension so it still opens inline", async () => {
      typed("application/octet-stream");
      const res = await get(key("chart.png"));
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    });

    it("never promotes an untyped non-inline file (HTML stays a download)", async () => {
      typed("application/octet-stream");
      const res = await get(key("page.html"));
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    });

    it("download=1 saves even an image as an attachment", async () => {
      typed("image/png");
      const res = await get(key("chart.png"), "&download=1");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="chart.png"/);
    });
  });

  it("403s another principal's object without signing or fetching", async () => {
    expect((await get(OTHER)).status).toBe(403);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated request", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await get(OWN)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the object cannot be signed", async () => {
    createSignedUrl.mockResolvedValueOnce({
      data: { signedUrl: "" },
      error: { message: "Object not found" },
    });
    expect((await get(OWN)).status).toBe(404);
  });

  it("streams another member's project-chat file only when Python confirms it", async () => {
    projectChatMedia.mockRejectedValue(new Error("403 not permitted"));
    expect((await get(OTHER, "&project=sales")).status).toBe(403);
    projectChatMedia.mockResolvedValue({ shared: true });
    expect((await get(OTHER, "&project=sales")).status).not.toBe(403);
    expect(projectChatMedia).toHaveBeenCalledWith("sales", OTHER);
  });

  it("501s when Storage is unconfigured on the box", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await get(OWN)).status).toBe(501);
  });
});
