import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectedAccounts,
  decisionOutcome,
  sameAddress,
  saveCare,
  telegramTriageOn,
  triageLayers,
} from "@/lib/sources/api";
import type { RoutingDecision } from "@/types";

afterEach(() => vi.restoreAllMocks());

const decision = (over: Partial<RoutingDecision> = {}): RoutingDecision => ({
  decision_id: 1,
  batch_id: "b-1",
  source_id: "s1",
  channel: "email",
  owner_user_id: "john",
  choices: [],
  selected: [],
  model: null,
  attempts: 1,
  fallback: false,
  error: null,
  decided_at: null,
  message_count: 2,
  first_sender: "amy@acme.com",
  ...over,
});

describe("sources api helpers", () => {
  it("names each decision Routed, Stored only or Fallback", () => {
    expect(decisionOutcome(decision({ selected: ["cfo"] }))).toBe("routed");
    expect(decisionOutcome(decision())).toBe("stored");
    expect(decisionOutcome(decision({ fallback: true, selected: ["cfo", "cmo"] }))).toBe("fallback");
  });

  it("treats Telegram triage as off unless the API says agent", () => {
    expect(telegramTriageOn({})).toBe(false);
    expect(telegramTriageOn({ telegram_triage: "off" })).toBe(false);
    expect(telegramTriageOn({ telegram_triage: "agent" })).toBe(true);
  });

  it("matches the same address written differently", () => {
    expect(sameAddress("email", "John@Acme.com ", "john@acme.com")).toBe(true);
    expect(sameAddress("whatsapp", "+852 6178 2290", "+85261782290")).toBe(true);
    expect(sameAddress("telegram", "@JohnBot", "johnbot")).toBe(true);
    expect(sameAddress("email", "a@x.com", "b@x.com")).toBe(false);
  });

  it("addresses the triage layer calls to the chosen profile", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push([String(input), init]);
      return new Response(JSON.stringify({ care: { content: "x" } }));
    });
    await triageLayers("cfo", "email");
    await saveCare("cmo", "whatsapp", "Campaign briefs");
    await saveCare("default", "email", "x");
    expect(calls[0][0]).toBe("/api/triage/layers?kind=email&profile=cfo");
    expect(calls[1][0]).toBe("/api/triage/layers/care?profile=cmo");
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ kind: "whatsapp", layer: "user", content: "Campaign briefs" });
    expect(calls[2][0]).toBe("/api/triage/layers/care");
  });

  it("lists connected accounts from the existing setup endpoints and survives one failing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/email/mailboxes")
        return new Response(JSON.stringify({ mailboxes: [{ address: "john@acme.com", state: "working" }] }));
      if (url === "/api/wa-bridges")
        return new Response(
          JSON.stringify({
            bridges: [
              { name: "john", paired: true, number: "+852 6178 2290", status: "connected" },
              { name: "spare", paired: false, number: null, status: "qr" },
            ],
          }),
        );
      return new Response(JSON.stringify({ detail: "down" }), { status: 502 });
    });
    const accounts = await connectedAccounts();
    expect(accounts.email).toEqual([
      expect.objectContaining({ address: "john@acme.com", detail: "working", credential_ref: { kind: "email-imap", name: "john@acme.com" } }),
    ]);
    expect(accounts.whatsapp.map((a) => a.address)).toEqual(["+852 6178 2290"]);
    expect(accounts.telegram).toEqual([]);
  });
});
