/**
 * The project Log BFF route: filters are validated route-locally, the rest
 * is passed through to the projects API, and a failure comes back as the
 * JSON error envelope the Log renders as its error line.
 */
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import { HermesApiError } from "@/lib/api/client";

const clientState: { client: unknown } = { client: null };

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: async () => ({ user_id: "leo" }),
  apiClientForRequest: async () => clientState.client,
}));

import { GET } from "./route";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("GET /api/projects/:slug/log", () => {
  it("rejects an unknown actor filter before touching upstream", async () => {
    clientState.client = { projectLog: vi.fn() };
    const res = await GET(new Request("http://x/api/projects/digest/log?actor=robots"), params("digest"));
    expect(res.status).toBe(400);
    expect((clientState.client as { projectLog: ReturnType<typeof vi.fn> }).projectLog).not.toHaveBeenCalled();
  });

  it("forwards actor, kind, cursor and limit to the projects API", async () => {
    const projectLog = vi.fn(async () => ({ entries: [], next_cursor: null }));
    clientState.client = { projectLog };
    const res = await GET(
      new Request("http://x/api/projects/digest/log?actor=people&kind=runs&cursor=10:run:1:start&limit=20"),
      params("digest"),
    );
    expect(res.status).toBe(200);
    expect(projectLog).toHaveBeenCalledWith("digest", {
      actor: "people",
      kind: "runs",
      cursor: "10:run:1:start",
      limit: 20,
    });
    expect(await res.json()).toEqual({ entries: [], next_cursor: null });
  });

  it("renders an upstream failure as a JSON error envelope", async () => {
    clientState.client = {
      projectLog: async () => {
        throw new HermesApiError(404, "project not found");
      },
    };
    const res = await GET(new Request("http://x/api/projects/digest/log"), params("digest"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
