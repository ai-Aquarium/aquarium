/** BFF tests for the FG-03 P7 source PATCH and claim-resolve routes. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH } from "@/app/api/sources/[sourceId]/route";
import { POST as RESOLVE } from "@/app/api/sources/conflicts/[conflictId]/resolve/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const updateSource = vi.fn();
const resolveSourceConflict = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ updateSource, resolveSourceConflict }),
}));

const JOHN: Principal = { user_id: "john", display: "John", role: "member", channels: [], is_owner: false };
const req = (body: unknown) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(JOHN);
});

describe("PATCH /api/sources/{id}", () => {
  const ctx = { params: Promise.resolve({ sourceId: "s1" }) };

  it("needs a signed-in principal", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await PATCH(req({ enabled: false }), ctx)).status).toBe(401);
    expect(updateSource).not.toHaveBeenCalled();
  });

  it("forwards only enabled/display", async () => {
    updateSource.mockResolvedValue({ source: { source_id: "s1" } });
    const res = await PATCH(req({ enabled: false, display: "Work", owner_user_id: "mary" }), ctx);
    expect(res.status).toBe(200);
    expect(updateSource).toHaveBeenCalledWith("s1", { enabled: false, display: "Work" });
  });

  it("rejects an empty or invalid body", async () => {
    expect((await PATCH(req({}), ctx)).status).toBe(400);
    expect((await PATCH(req("nope"), ctx)).status).toBe(400);
    expect(updateSource).not.toHaveBeenCalled();
  });

  it("passes Hermes errors on", async () => {
    updateSource.mockRejectedValue(new HermesApiError(403, "not yours"));
    expect((await PATCH(req({ enabled: true }), ctx)).status).toBe(403);
  });
});

describe("POST /api/sources/conflicts/{id}/resolve", () => {
  const ctx = (conflictId: string) => ({ params: Promise.resolve({ conflictId }) });

  it("forwards keep/transfer", async () => {
    resolveSourceConflict.mockResolvedValue({ conflict: { conflict_id: 7 } });
    expect((await RESOLVE(req({ action: "transfer" }), ctx("7"))).status).toBe(200);
    expect(resolveSourceConflict).toHaveBeenCalledWith(7, "transfer");
  });

  it("rejects a bad id or action", async () => {
    expect((await RESOLVE(req({ action: "keep" }), ctx("abc"))).status).toBe(400);
    expect((await RESOLVE(req({ action: "delete" }), ctx("7"))).status).toBe(400);
    expect(resolveSourceConflict).not.toHaveBeenCalled();
  });

  it("passes the admin check from Hermes on", async () => {
    resolveSourceConflict.mockRejectedValue(new HermesApiError(403, "admins only"));
    expect((await RESOLVE(req({ action: "keep" }), ctx("7"))).status).toBe(403);
  });
});
