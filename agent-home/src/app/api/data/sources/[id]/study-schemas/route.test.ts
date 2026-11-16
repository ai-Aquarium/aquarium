import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "@/app/api/data/sources/[id]/study-schemas/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const studySchemas = vi.fn();
const putStudySchemas = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ studySchemas, putStudySchemas }),
}));

const ALICE: Principal = { user_id: "alice", display: "Alice", role: "member", channels: [], is_owner: false };
const ctx = { params: Promise.resolve({ id: "src-1" }) };
const put = (body: unknown) =>
  new Request("http://localhost/api/data/sources/src-1/study-schemas", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(ALICE);
});

describe("study-schemas BFF", () => {
  it("401s without a principal and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost"), ctx)).status).toBe(401);
    expect((await PUT(put({ schemas: [] }), ctx)).status).toBe(401);
    expect(studySchemas).not.toHaveBeenCalled();
    expect(putStudySchemas).not.toHaveBeenCalled();
  });

  it("forwards GET and PUT for the source", async () => {
    studySchemas.mockResolvedValue({ chosen: ["sales"], available: ["hr", "sales"] });
    expect(await (await GET(new Request("http://localhost"), ctx)).json()).toEqual({ chosen: ["sales"], available: ["hr", "sales"] });
    expect(studySchemas).toHaveBeenCalledWith("src-1");
    putStudySchemas.mockResolvedValue({ chosen: ["hr"] });
    expect(await (await PUT(put({ schemas: ["hr"] }), ctx)).json()).toEqual({ chosen: ["hr"] });
    expect(putStudySchemas).toHaveBeenCalledWith("src-1", ["hr"]);
  });

  it("rejects a body without a list of names and passes Hermes errors on", async () => {
    expect((await PUT(put({ schemas: "hr" }), ctx)).status).toBe(400);
    expect((await PUT(put({ schemas: [1] }), ctx)).status).toBe(400);
    putStudySchemas.mockRejectedValue(new HermesApiError(403, "manage access needed"));
    expect((await PUT(put({ schemas: [] }), ctx)).status).toBe(403);
  });
});
