/**
 * BFF tests for the FG-03 P3 triage skill layer routes: every signed-in
 * person, bound to `?profile=`; Hermes decides who may change the template
 * (the caller's role in that profile) and its refusals are replayed as-is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUT as CARE } from "@/app/api/triage/layers/care/route";
import { GET as DIFF } from "@/app/api/triage/layers/diff/route";
import { POST as DISABLE } from "@/app/api/triage/layers/disable/route";
import { GET as FILE, PUT as SAVE } from "@/app/api/triage/layers/file/route";
import { GET as HISTORY } from "@/app/api/triage/layers/history/route";
import { POST as RESET } from "@/app/api/triage/layers/reset/route";
import { GET as LAYERS } from "@/app/api/triage/layers/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const client = {
  triageLayers: vi.fn(),
  triageLayerFile: vi.fn(),
  triageLayerDiff: vi.fn(),
  triageLayerHistory: vi.fn(),
  saveTriageLayerFile: vi.fn(),
  setTriageLayerDisabled: vi.fn(),
  resetTriageLayer: vi.fn(),
  saveTriageCare: vi.fn(),
};
const apiClientForRequest = vi.fn<(opts?: { profile?: string }) => Promise<typeof client>>(async () => client);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: (opts?: { profile?: string }) => apiClientForRequest(opts),
}));

const who = (role: Principal["role"]): Principal => ({ user_id: role, display: role, role, channels: [], is_owner: role === "owner" });
const KEY = "email-triage/classify-emails.md";
const base = "http://localhost/api/triage/layers";
const get = (path: string, query: string) => new Request(`${base}${path}?${query}`);
const send = (path: string, method: string, body: unknown, query = "?profile=cfo") =>
  new Request(`${base}${path}${query}`, { method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(who("member"));
});

describe("GET /api/triage/layers", () => {
  it("401s without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await LAYERS(get("", "kind=email"))).status).toBe(401);
    expect(client.triageLayers).not.toHaveBeenCalled();
  });

  it("forwards under ?profile=", async () => {
    client.triageLayers.mockResolvedValue({ kind: "email", files: [] });
    const res = await LAYERS(get("", "kind=email&profile=cfo"));
    expect(res.status).toBe(200);
    expect(client.triageLayers).toHaveBeenCalledWith("email");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "cfo" });
  });

  it("needs kind", async () => {
    expect((await LAYERS(get("", ""))).status).toBe(400);
  });

  it("replays a profile-scope refusal", async () => {
    client.triageLayers.mockRejectedValue(new HermesApiError(403, "not enrolled in hr"));
    expect((await LAYERS(get("", "kind=email&profile=hr"))).status).toBe(403);
  });
});

describe("GET /api/triage/layers/file, diff, history", () => {
  it("defaults to the effective layer", async () => {
    client.triageLayerFile.mockResolvedValue({ key: KEY, content: "x" });
    const res = await FILE(get("/file", `kind=email&key=${encodeURIComponent(KEY)}&profile=cfo`));
    expect(res.status).toBe(200);
    expect(client.triageLayerFile).toHaveBeenCalledWith("email", KEY, "effective");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "cfo" });
  });

  it("refuses an unknown layer and a missing key", async () => {
    expect((await FILE(get("/file", `kind=email&key=${KEY}&layer=root`))).status).toBe(400);
    expect((await FILE(get("/file", "kind=email"))).status).toBe(400);
    expect(client.triageLayerFile).not.toHaveBeenCalled();
  });

  it("passes Hermes' 400 for a traversal key through", async () => {
    client.triageLayerFile.mockRejectedValue(new HermesApiError(400, "invalid triage skill key"));
    expect((await FILE(get("/file", "kind=email&key=..%2Fx.md"))).status).toBe(400);
  });

  it("forwards diff and history", async () => {
    client.triageLayerDiff.mockResolvedValue({ changed: false, diff: "" });
    client.triageLayerHistory.mockResolvedValue({ versions: [] });
    expect((await DIFF(get("/diff", `kind=email&key=${KEY}&profile=cfo`))).status).toBe(200);
    expect(client.triageLayerDiff).toHaveBeenCalledWith("email", KEY);
    expect((await HISTORY(get("/history", `kind=email&key=${KEY}&layer=user`))).status).toBe(200);
    expect(client.triageLayerHistory).toHaveBeenCalledWith("email", KEY, "user");
    expect((await HISTORY(get("/history", `kind=email&key=${KEY}&layer=builtin`))).status).toBe(400);
  });
});

describe("writes", () => {
  it("lets a member save their own layer, bound to ?profile=", async () => {
    client.saveTriageLayerFile.mockResolvedValue({ ok: true });
    const res = await SAVE(send("/file", "PUT", { kind: "email", layer: "user", key: KEY, content: "# mine" }));
    expect(res.status).toBe(200);
    expect(client.saveTriageLayerFile).toHaveBeenCalledWith("email", "user", KEY, "# mine");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "cfo" });
  });

  it("forwards a template save and replays Hermes' 403 for a member there", async () => {
    client.saveTriageLayerFile.mockRejectedValue(new HermesApiError(403, "Only the owner or an admin can change this setting."));
    const res = await SAVE(send("/file", "PUT", { kind: "email", layer: "template", key: KEY, content: "x" }));
    expect(res.status).toBe(403);
    expect(client.saveTriageLayerFile).toHaveBeenCalledWith("email", "template", KEY, "x");
  });

  it("checks the body shape", async () => {
    expect((await SAVE(send("/file", "PUT", { kind: "email", layer: "builtin", key: KEY, content: "x" }))).status).toBe(400);
    expect((await SAVE(send("/file", "PUT", { kind: "email", layer: "user", key: KEY }))).status).toBe(400);
    expect((await DISABLE(send("/disable", "POST", { kind: "email", layer: "user", key: KEY }))).status).toBe(400);
    expect((await CARE(send("/care", "PUT", { kind: "email", layer: "user" }))).status).toBe(400);
    expect((await RESET(send("/reset", "POST", { kind: "email", key: "" }))).status).toBe(400);
    expect(client.saveTriageLayerFile).not.toHaveBeenCalled();
  });

  it("401s writes without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await SAVE(send("/file", "PUT", { kind: "email", layer: "user", key: KEY, content: "x" }))).status).toBe(401);
    expect((await RESET(send("/reset", "POST", { kind: "email" }))).status).toBe(401);
    expect(client.saveTriageLayerFile).not.toHaveBeenCalled();
    expect(client.resetTriageLayer).not.toHaveBeenCalled();
  });

  it("forwards disable, reset (one key or all) and care", async () => {
    client.setTriageLayerDisabled.mockResolvedValue({ ok: true });
    client.resetTriageLayer.mockResolvedValue({ ok: true, reset: [] });
    client.saveTriageCare.mockResolvedValue({ ok: true });
    expect((await DISABLE(send("/disable", "POST", { kind: "email", layer: "user", key: KEY, disabled: true }))).status).toBe(200);
    expect(client.setTriageLayerDisabled).toHaveBeenCalledWith("email", "user", KEY, true);
    expect((await RESET(send("/reset", "POST", { kind: "email", key: KEY }))).status).toBe(200);
    expect(client.resetTriageLayer).toHaveBeenLastCalledWith("email", KEY);
    expect((await RESET(send("/reset", "POST", { kind: "email" }))).status).toBe(200);
    expect(client.resetTriageLayer).toHaveBeenLastCalledWith("email", undefined);
    expect((await CARE(send("/care", "PUT", { kind: "email", layer: "user", content: "Invoices" }))).status).toBe(200);
    expect(client.saveTriageCare).toHaveBeenCalledWith("email", "user", "Invoices");
  });

  it("replays Hermes' 422 for an empty care section", async () => {
    client.saveTriageCare.mockRejectedValue(new HermesApiError(422, "can't be empty"));
    expect((await CARE(send("/care", "PUT", { kind: "email", layer: "user", content: " " }))).status).toBe(422);
  });
});
