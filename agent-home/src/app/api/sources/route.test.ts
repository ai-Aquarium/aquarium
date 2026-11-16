/**
 * BFF tests for the FG-03 source registry: every route needs a signed-in
 * principal, forwards under the bridged client and passes Hermes errors on
 * (the one-owner and owner-only rules live in Hermes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE } from "@/app/api/sources/[sourceId]/route";
import { PUT } from "@/app/api/sources/[sourceId]/routes/[profile]/route";
import { GET as CONFLICTS } from "@/app/api/sources/conflicts/route";
import { GET as COMPARISONS } from "@/app/api/sources/comparisons/route";
import { GET as DECISIONS } from "@/app/api/sources/decisions/route";
import { GET, POST } from "@/app/api/sources/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const sources = vi.fn();
const registerSource = vi.fn();
const putSourceRoute = vi.fn();
const deleteSource = vi.fn();
const sourceConflicts = vi.fn();
const sourceDecisions = vi.fn();
const sourceComparisons = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    sources, registerSource, putSourceRoute, deleteSource, sourceConflicts, sourceDecisions,
    sourceComparisons,
  }),
}));

const JOHN: Principal = { user_id: "john", display: "John", role: "member", channels: [], is_owner: false };
const json = (method: string, body: unknown) =>
  new Request("http://localhost/api/sources", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const routeCtx = { params: Promise.resolve({ sourceId: "s1", profile: "cfo" }) };
const sourceCtx = { params: Promise.resolve({ sourceId: "s1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(JOHN);
});

describe("unauthenticated", () => {
  it("401s on every route and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    const responses = [
      await GET(new Request("http://localhost/api/sources")),
      await POST(json("POST", {})),
      await PUT(json("PUT", { enabled: true }), routeCtx),
      await DELETE(new Request("http://localhost"), sourceCtx),
      await CONFLICTS(new Request("http://localhost/api/sources/conflicts")),
      await DECISIONS(new Request("http://localhost/api/sources/decisions")),
      await COMPARISONS(new Request("http://localhost/api/sources/comparisons")),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
    for (const fn of [
      sources, registerSource, putSourceRoute, deleteSource, sourceConflicts, sourceDecisions,
      sourceComparisons,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("forwarding", () => {
  it("GET lists the caller's sources; ?all=1 asks for the box-wide list", async () => {
    sources.mockResolvedValue({ sources: [], is_box_admin: false });
    expect((await GET(new Request("http://localhost/api/sources"))).status).toBe(200);
    expect(sources).toHaveBeenLastCalledWith(false);
    await GET(new Request("http://localhost/api/sources?all=1"));
    expect(sources).toHaveBeenLastCalledWith(true);
  });

  it("POST forwards the body; bad JSON is a 400", async () => {
    registerSource.mockResolvedValue({ source: { source_id: "s1" } });
    const body = { channel: "email", address: "John@Example.com" };
    expect((await POST(json("POST", body))).status).toBe(200);
    expect(registerSource).toHaveBeenCalledWith(body);
    expect((await POST(json("POST", "{nope"))).status).toBe(400);
    expect((await POST(json("POST", [1]))).status).toBe(400);
  });

  it("PUT forwards the route toggle; a non-boolean enabled is a 400", async () => {
    putSourceRoute.mockResolvedValue({ route: { profile_slug: "cfo", enabled: true } });
    expect((await PUT(json("PUT", { enabled: true }), routeCtx)).status).toBe(200);
    expect(putSourceRoute).toHaveBeenCalledWith("s1", "cfo", true);
    expect((await PUT(json("PUT", { enabled: "yes" }), routeCtx)).status).toBe(400);
  });

  it("passes Hermes refusals (409 claimed, 403 not the owner) through", async () => {
    registerSource.mockRejectedValue(new HermesApiError(409, "already registered to another user"));
    expect((await POST(json("POST", { channel: "email", address: "a@b.com" }))).status).toBe(409);
    deleteSource.mockRejectedValue(new HermesApiError(403, "only the source's owner may change it"));
    expect((await DELETE(new Request("http://localhost"), sourceCtx)).status).toBe(403);
  });

  it("GET decisions forwards the filters; Hermes scopes them to the caller", async () => {
    sourceDecisions.mockResolvedValue({ decisions: [] });
    const r = await DECISIONS(new Request(
      "http://localhost/api/sources/decisions?source_id=s1&batch_id=b1&limit=5",
    ));
    expect(r.status).toBe(200);
    expect(sourceDecisions).toHaveBeenLastCalledWith({
      sourceId: "s1", batchId: "b1", limit: 5, all: false,
    });
    await DECISIONS(new Request("http://localhost/api/sources/decisions?all=1&limit=x"));
    expect(sourceDecisions).toHaveBeenLastCalledWith({
      sourceId: undefined, batchId: undefined, limit: undefined, all: true,
    });
    sourceDecisions.mockRejectedValue(new HermesApiError(403, "Only the box owner"));
    expect((await DECISIONS(new Request("http://localhost/api/sources/decisions?all=1"))).status).toBe(403);
  });

  it("GET comparisons forwards the filters; Hermes scopes them to the caller", async () => {
    sourceComparisons.mockResolvedValue({ comparisons: [] });
    const r = await COMPARISONS(new Request(
      "http://localhost/api/sources/comparisons?source_id=s1&batch_id=b1&limit=5",
    ));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ comparisons: [] });
    expect(sourceComparisons).toHaveBeenLastCalledWith({
      sourceId: "s1", batchId: "b1", limit: 5, all: false,
    });
    await COMPARISONS(new Request("http://localhost/api/sources/comparisons?all=1&limit=x"));
    expect(sourceComparisons).toHaveBeenLastCalledWith({
      sourceId: undefined, batchId: undefined, limit: undefined, all: true,
    });
    sourceComparisons.mockRejectedValue(new HermesApiError(403, "Only the box owner"));
    expect(
      (await COMPARISONS(new Request("http://localhost/api/sources/comparisons?all=1"))).status,
    ).toBe(403);
  });

  it("502s when Hermes is unreachable", async () => {
    sourceConflicts.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await CONFLICTS(new Request("http://localhost/api/sources/conflicts"))).status).toBe(502);
  });
});
