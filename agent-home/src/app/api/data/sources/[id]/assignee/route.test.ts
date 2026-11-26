import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUT } from "@/app/api/data/sources/[id]/assignee/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const putDataAssignee = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ putDataAssignee }),
}));

const LEO: Principal = { user_id: "leo", display: "Leo", role: "owner", channels: [], is_owner: true };
const ctx = { params: Promise.resolve({ id: "src-1" }) };
const put = (body: unknown) =>
  new Request("http://localhost/api/data/sources/src-1/assignee", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(LEO);
});

describe("assignee BFF", () => {
  it("401s without a principal and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await PUT(put({ user_id: "leo" }), ctx)).status).toBe(401);
    expect(putDataAssignee).not.toHaveBeenCalled();
  });

  it("forwards the assignee, including clearing it", async () => {
    putDataAssignee.mockResolvedValue({ owner_user_id: "" });
    expect(await (await PUT(put({ user_id: "" }), ctx)).json()).toEqual({ owner_user_id: "" });
    expect(putDataAssignee).toHaveBeenCalledWith("src-1", "");
  });

  it("rejects a body without user_id and passes Hermes errors on", async () => {
    expect((await PUT(put({ user_id: 3 }), ctx)).status).toBe(400);
    putDataAssignee.mockRejectedValue(new HermesApiError(403, "owner or admin only"));
    expect((await PUT(put({ user_id: "sam" }), ctx)).status).toBe(403);
  });
});
