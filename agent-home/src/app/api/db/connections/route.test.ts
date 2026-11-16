/**
 * BFF tests for the per-person MySQL / SQLite connections: every route needs a
 * signed-in principal, forwards engine + name under the bridged client and
 * passes Hermes errors on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, PUT } from "@/app/api/db/connections/[engine]/[name]/route";
import { POST } from "@/app/api/db/connections/[engine]/[name]/test/route";
import { GET } from "@/app/api/db/connections/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const dbConnections = vi.fn();
const putDbConnection = vi.fn();
const deleteDbConnection = vi.fn();
const testDbConnection = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ dbConnections, putDbConnection, deleteDbConnection, testDbConnection }),
}));

const ALICE: Principal = { user_id: "alice", display: "Alice", role: "member", channels: [], is_owner: false };
const ctx = (engine: string, name: string) => ({ params: Promise.resolve({ engine, name }) });
const put = (body: unknown) =>
  new Request("http://localhost/api/db/connections/mysql/x", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(ALICE);
});

describe("db connections BFF", () => {
  it("401s on every route and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    const statuses = [
      (await GET()).status,
      (await PUT(put({}), ctx("mysql", "CRM"))).status,
      (await DELETE(new Request("http://localhost"), ctx("mysql", "CRM"))).status,
      (await POST(new Request("http://localhost"), ctx("mysql", "CRM"))).status,
    ];
    expect(statuses).toEqual([401, 401, 401, 401]);
    for (const fn of [dbConnections, putDbConnection, deleteDbConnection, testDbConnection]) expect(fn).not.toHaveBeenCalled();
  });

  it("forwards engine, name and body; bad JSON is a 400", async () => {
    dbConnections.mockResolvedValue({ connections: [], drivers: { mysql: true, sqlite: true } });
    expect(await (await GET()).json()).toEqual({ connections: [], drivers: { mysql: true, sqlite: true } });
    putDbConnection.mockResolvedValue({ connection: { engine: "mysql", name: "CRM" } });
    expect((await PUT(put({ host: "db1" }), ctx("mysql", "CRM"))).status).toBe(200);
    expect(putDbConnection).toHaveBeenCalledWith("mysql", "CRM", { host: "db1" });
    expect((await PUT(put("{nope"), ctx("mysql", "CRM"))).status).toBe(400);
    expect((await PUT(put([1]), ctx("mysql", "CRM"))).status).toBe(400);
    testDbConnection.mockResolvedValue({ connection: { engine: "sqlite", name: "Prices" }, test: { ok: true, tables: 3 } });
    expect(await (await POST(new Request("http://localhost"), ctx("sqlite", "Prices"))).json()).toEqual({
      connection: { engine: "sqlite", name: "Prices" },
      test: { ok: true, tables: 3 },
    });
    expect(testDbConnection).toHaveBeenCalledWith("sqlite", "Prices");
  });

  it("passes Hermes 403/404 through", async () => {
    putDbConnection.mockRejectedValue(new HermesApiError(403, "only the owner or an admin can add SQLite files"));
    expect((await PUT(put({ path: "/x.db" }), ctx("sqlite", "Prices"))).status).toBe(403);
    deleteDbConnection.mockRejectedValue(new HermesApiError(404, "no mysql connection with that name"));
    expect((await DELETE(new Request("http://localhost"), ctx("mysql", "Nope"))).status).toBe(404);
  });
});
