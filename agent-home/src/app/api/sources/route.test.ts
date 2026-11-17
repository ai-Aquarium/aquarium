/**
 * BFF tests for the FG-03 source registry: every route needs a signed-in
 * principal, forwards under the bridged client and passes Hermes errors on
 * (the one-owner and owner-only rules live in Hermes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, PATCH } from "@/app/api/sources/[sourceId]/route";
import { PUT } from "@/app/api/sources/[sourceId]/routes/[profile]/route";
import { POST as RESOLVE } from "@/app/api/sources/conflicts/[conflictId]/resolve/route";
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
const updateSource = vi.fn();
const resolveSourceConflict = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    sources, registerSource, putSourceRoute, deleteSource, sourceConflicts, sourceDecisions,
    sourceComparisons, updateSource, resolveSourceConflict,
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
const conflictCtx = (conflictId: string) => ({ params: Promise.resolve({ conflictId }) });

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
      await PATCH(json("PATCH", { enabled: false }), sourceCtx),
      await RESOLVE(json("POST", { action: "keep" }), conflictCtx("7")),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401]);
    for (const fn of [
      sources, registerSource, putSourceRoute, deleteSource, sourceConflicts, sourceDecisions,
      sourceComparisons, updateSource, resolveSourceConflict,
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
    const wa = { channel: "whatsapp", credential_ref: { kind: "wa-bridge", bridge: "johnwa" } };
    expect((await POST(json("POST", wa))).status).toBe(200);
    expect(registerSource).toHaveBeenLastCalledWith(wa);
    expect((await POST(json("POST", "{nope"))).status).toBe(400);
    expect((await POST(json("POST", [1]))).status).toBe(400);
  });

  it("POST keeps a refused claim's owner display name; otherwise a plain 409", async () => {
    registerSource.mockRejectedValueOnce(
      new HermesApiError(409, "already registered to another user", { detail: "x", owner_display: "Mary" }),
    );
    const r = await POST(json("POST", { channel: "email", address: "a@b.c" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "api_error", detail: "already registered to another user", owner_display: "Mary" });
    registerSource.mockRejectedValueOnce(new HermesApiError(409, "taken", { detail: "taken", owner_display: null }));
    const plain = await POST(json("POST", { channel: "email", address: "a@b.c" }));
    expect(await plain.json()).toEqual({ error: "api_error", detail: "taken" });
  });

  it("PUT forwards the route toggle; a non-boolean enabled is a 400", async () => {
    putSourceRoute.mockResolvedValue({ route: { profile_slug: "cfo", enabled: true } });
    expect((await PUT(json("PUT", { enabled: true }), routeCtx)).status).toBe(200);
    expect(putSourceRoute).toHaveBeenCalledWith("s1", "cfo", true);
    expect((await PUT(json("PUT", { enabled: "yes" }), routeCtx)).status).toBe(400);
  });

  it("PATCH forwards only the given fields; null clears display; bad types are a 400", async () => {
    updateSource.mockResolvedValue({ source: { source_id: "s1", enabled: false } });
    expect((await PATCH(json("PATCH", { enabled: false }), sourceCtx)).status).toBe(200);
    expect(updateSource).toHaveBeenLastCalledWith("s1", { enabled: false });
    await PATCH(json("PATCH", { display: null, extra: 1 }), sourceCtx);
    expect(updateSource).toHaveBeenLastCalledWith("s1", { display: null });
    await PATCH(json("PATCH", { enabled: true, display: "Work" }), sourceCtx);
    expect(updateSource).toHaveBeenLastCalledWith("s1", { enabled: true, display: "Work" });
    expect((await PATCH(json("PATCH", { enabled: "no" }), sourceCtx)).status).toBe(400);
    expect((await PATCH(json("PATCH", { display: 5 }), sourceCtx)).status).toBe(400);
    expect((await PATCH(json("PATCH", "{nope"), sourceCtx)).status).toBe(400);
    expect(updateSource).toHaveBeenCalledTimes(3);
    updateSource.mockRejectedValue(new HermesApiError(403, "Only the source's owner"));
    expect((await PATCH(json("PATCH", { enabled: true }), sourceCtx)).status).toBe(403);
  });

  it("POST resolve forwards keep/transfer; bad ids and actions are a 400", async () => {
    resolveSourceConflict.mockResolvedValue({ conflict: { conflict_id: 7, resolution: "keep" } });
    const r = await RESOLVE(json("POST", { action: "keep" }), conflictCtx("7"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ conflict: { conflict_id: 7, resolution: "keep" } });
    expect(resolveSourceConflict).toHaveBeenLastCalledWith(7, "keep");
    await RESOLVE(json("POST", { action: "transfer" }), conflictCtx("7"));
    expect(resolveSourceConflict).toHaveBeenLastCalledWith(7, "transfer");
    expect((await RESOLVE(json("POST", { action: "maybe" }), conflictCtx("7"))).status).toBe(400);
    expect((await RESOLVE(json("POST", { action: "keep" }), conflictCtx("x7"))).status).toBe(400);
    expect((await RESOLVE(json("POST", "{nope"), conflictCtx("7"))).status).toBe(400);
    expect(resolveSourceConflict).toHaveBeenCalledTimes(2);
    resolveSourceConflict.mockRejectedValue(new HermesApiError(403, "Only the box owner"));
    expect((await RESOLVE(json("POST", { action: "keep" }), conflictCtx("7"))).status).toBe(403);
  });

  it("POST masks a WhatsApp number Hermes' refusal echoes back", async () => {
    registerSource.mockRejectedValueOnce(
      new HermesApiError(409, "85291234567 is already registered to another user", {
        detail: "85291234567 is already registered to another user",
        owner_display: "Mary",
      }),
    );
    const r = await POST(json("POST", { channel: "whatsapp", address: "+852 9123 4567" }));
    expect(r.status).toBe(409);
    const text = await r.text();
    expect(text).not.toContain("85291234567");
    expect(JSON.parse(text)).toMatchObject({ detail: "+85••••••67 is already registered to another user", owner_display: "Mary" });
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
