import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminFetchError } from "@/lib/admin-fetch";
import {
  accountsOf,
  channelAccounts,
  connectedAccounts,
  decisionOutcome,
  registerBody,
  registerErrorHint,
  sameAccount,
  sameAddress,
  saveCare,
  telegramTriageOn,
  triageLayers,
} from "@/lib/sources/api";
import type { RoutingDecision, Source } from "@/types";

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
    expect(calls[2][0]).toBe("/api/triage/layers/care?profile=default");
  });

  it("lists connected accounts per channel and reports a failing endpoint as failed, not empty", async () => {
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
    expect(accountsOf(accounts.email)).toEqual([
      expect.objectContaining({ address: "john@acme.com", detail: "working", credential_ref: { kind: "email-imap", name: "john@acme.com" } }),
    ]);
    expect(accountsOf(accounts.whatsapp).map((a) => a.address)).toEqual(["+852 6178 2290"]);
    expect(accounts.telegram).toEqual({ state: "failed", status: 502, detail: "down" });
    expect(accountsOf(accounts.telegram)).toEqual([]);
  });

  it("keeps a genuine empty answer distinct from a failure, per channel", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/email/mailboxes") return new Response(JSON.stringify({ mailboxes: [] }));
      if (url === "/api/wa-bridges") return new Response(JSON.stringify({ detail: "unavailable" }), { status: 503 });
      return new Response(JSON.stringify({ configured: false }));
    });
    expect(await channelAccounts("email")).toEqual({ state: "ok", accounts: [] });
    expect(await channelAccounts("whatsapp")).toMatchObject({ state: "failed", status: 503 });
    expect(await channelAccounts("telegram")).toEqual({ state: "ok", accounts: [] });
  });

  it("lets Hermes derive WhatsApp / Telegram addresses from the credential ref", () => {
    const wa = { channel: "whatsapp" as const, address: "+852****4567", display: "john-wa", detail: "working" as const, credential_ref: { kind: "wa-bridge", bridge: "john-wa" } };
    const tg = { channel: "telegram" as const, address: "@JohnBot", display: null, detail: "working" as const, credential_ref: { kind: "telegram-bot" } };
    const mail = { channel: "email" as const, address: "john@acme.com", display: null, detail: "working" as const, credential_ref: { kind: "email-imap", name: "john@acme.com" } };
    expect(registerBody(wa)).toEqual({ channel: "whatsapp", display: "john-wa", credential_ref: { kind: "wa-bridge", bridge: "john-wa" } });
    expect(registerBody(tg)).not.toHaveProperty("address");
    expect(registerBody(mail).address).toBe("john@acme.com");

    const src = (over: Partial<Source>): Source => ({
      source_id: "s", channel: "whatsapp", address: "+85291234567", owner_user_id: "john", display: null,
      credential_ref: null, enabled: true, created_at: null, updated_at: null, routes: [], ...over,
    });
    expect(sameAccount(wa, src({ credential_ref: { kind: "wa-bridge", bridge: "john-wa" } }))).toBe(true);
    expect(sameAccount(wa, src({ credential_ref: { kind: "wa-bridge", bridge: "other" } }))).toBe(false);
    expect(sameAccount(tg, src({ channel: "telegram", address: "123456", credential_ref: { kind: "telegram-bot" } }))).toBe(true);
    expect(sameAccount(mail, src({ channel: "email", address: "John@acme.com" }))).toBe(true);
  });

  it("maps each register failure from Hermes to a plain-language hint", () => {
    const e = (status: number, detail = "x") => new AdminFetchError(status, detail);
    expect(registerErrorHint(e(400), "whatsapp")).toEqual({ kind: "hint", key: "wizard.err.badRef", setup: false });
    expect(registerErrorHint(e(403), "telegram")).toEqual({ kind: "hint", key: "wizard.err.notYours.telegram", setup: false });
    expect(registerErrorHint(e(404), "whatsapp")).toEqual({ kind: "hint", key: "wizard.err.missing.whatsapp", setup: true });
    expect(registerErrorHint(e(409, "This WhatsApp bridge is not linked to a phone yet."), "whatsapp")).toMatchObject({ key: "wizard.err.notLinked" });
    expect(registerErrorHint(e(409, "This Telegram bot has no valid token saved."), "telegram")).toMatchObject({ key: "wizard.err.noToken" });
    expect(registerErrorHint(e(409, "This is the profile's own Telegram bot, not one person's source."), "telegram")).toMatchObject({ key: "wizard.err.profileBot" });
    expect(registerErrorHint(e(409, "This WhatsApp number is already registered to another user."), "whatsapp")).toEqual({ kind: "claim" });
    expect(registerErrorHint(e(500), "email")).toBeNull();
    expect(registerErrorHint(new Error("offline"), "email")).toBeNull();
  });
});
