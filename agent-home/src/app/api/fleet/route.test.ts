/**
 * BFF tests for Settings → Fleet: owner only; admins, members, viewers and
 * logged-out callers are refused before Python is called.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as availableGET } from "@/app/api/fleet/available/route";
import { GET as jobGET } from "@/app/api/fleet/job/route";
import { GET } from "@/app/api/fleet/route";
import { POST as switchPOST } from "@/app/api/fleet/switch/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const fleet = vi.fn();
const fleetAvailable = vi.fn();
const fleetJob = vi.fn();
const fleetSwitch = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ fleet, fleetAvailable, fleetJob, fleetSwitch }),
}));

function who(role: Principal["role"]): Principal {
  return { user_id: role, display: role, role, channels: [], is_owner: role === "owner" };
}

const switchReq = (body: unknown) =>
  new Request("http://x/api/fleet/switch", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const allCalls = () => [fleet, fleetAvailable, fleetJob, fleetSwitch];

describe("/api/fleet BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(who("owner"));
    fleetAvailable.mockResolvedValue({ available: true });
    fleet.mockResolvedValue({ available: true, boxes: [] });
    fleetJob.mockResolvedValue({ available: true, jobs: {} });
    fleetSwitch.mockResolvedValue({ started: true, box: "hsd", layout: "git", job: null });
  });

  it("owner reads status, the probe and jobs", async () => {
    expect((await GET()).status).toBe(200);
    expect((await availableGET()).status).toBe(200);
    expect((await jobGET()).status).toBe(200);
    expect(fleet).toHaveBeenCalledTimes(1);
    expect(fleetAvailable).toHaveBeenCalledTimes(1);
    expect(fleetJob).toHaveBeenCalledTimes(1);
  });

  it("non-owners and logged-out callers get refused before Python", async () => {
    for (const principal of [who("admin"), who("member"), who("viewer"), null]) {
      getPrincipal.mockResolvedValue(principal);
      expect((await GET()).status).toBe(principal ? 403 : 401);
      expect((await availableGET()).status).toBe(principal ? 403 : 401);
      expect((await jobGET()).status).toBe(principal ? 403 : 401);
      expect(
        (
          await switchPOST(
            switchReq({ box: "hsd", layout: "git", password: "pw" }),
          )
        ).status,
      ).toBe(principal ? 403 : 401);
    }
    for (const call of allCalls()) expect(call).not.toHaveBeenCalled();
  });

  it("an owner switch forwards box, layout and password as 202", async () => {
    const res = await switchPOST(
      switchReq({ box: "hsd", layout: "git", password: "pw" }),
    );
    expect(res.status).toBe(202);
    expect(fleetSwitch).toHaveBeenCalledWith({
      box: "hsd",
      layout: "git",
      password: "pw",
    });
  });

  it("bad input is refused before Python", async () => {
    for (const body of [
      "not json",
      { box: "BAD BOX", layout: "git", password: "pw" },
      { box: "hsd", layout: "sideways", password: "pw" },
      { box: "hsd", layout: "git" },
    ]) {
      expect((await switchPOST(switchReq(body))).status).toBe(400);
    }
    expect(fleetSwitch).not.toHaveBeenCalled();
  });

  it("an upstream refusal keeps its status", async () => {
    fleetSwitch.mockRejectedValue(new HermesApiError(400, "a switch is already running on HSD"));
    const res = await switchPOST(
      switchReq({ box: "hsd", layout: "git", password: "pw" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain("already running");
  });

  it("an unreachable AI layer is a 502", async () => {
    fleet.mockRejectedValue(new Error("connect refused"));
    expect((await GET()).status).toBe(502);
  });
});
