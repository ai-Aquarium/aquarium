import { afterEach, describe, expect, it, vi } from "vitest";

import { HermesApiClient } from "@/lib/api/client";
import { displayAddress, displaySender, maskConflict, maskPhoneNumbers, maskWhatsAppNumber } from "@/lib/sources/mask";

afterEach(() => vi.restoreAllMocks());

describe("WhatsApp number masking", () => {
  it("keeps the first 2 and last 2 digits behind a fixed-length mask", () => {
    expect(maskWhatsAppNumber("+15550002001")).toBe("+15••••••01");
    expect(maskWhatsAppNumber("85291234567")).toBe("+85••••••67");
    expect(maskWhatsAppNumber("+852 9123 4567")).toBe("+85••••••67");
    expect(maskWhatsAppNumber("85291234567@s.whatsapp.net")).toBe("+85••••••67");
    expect(maskWhatsAppNumber("1234")).toBe("+••••••");
    expect(maskWhatsAppNumber("+85••••••67")).toBe("+85••••••67");
  });

  it("masks only WhatsApp: email and Telegram show as they are", () => {
    expect(displayAddress("whatsapp", "85291234567")).toBe("+85••••••67");
    expect(displayAddress("email", "john@acme.com")).toBe("john@acme.com");
    expect(displayAddress("telegram", "123456789")).toBe("123456789");
    expect(displaySender("whatsapp", "Ann <+85211112222>")).toBe("Ann <+85••••••22>");
    expect(displaySender("email", "ap@supplier.com")).toBe("ap@supplier.com");
    expect(maskPhoneNumbers("85291234567 is already registered")).toBe("+85••••••67 is already registered");
  });

  it("masks a conflict's address and detail", () => {
    const c = maskConflict({ channel: "whatsapp", address: "85291234567", detail: "85291234567 taken" });
    expect(c).toEqual({ channel: "whatsapp", address: "+85••••••67", detail: "+85••••••67 taken" });
  });

  it("the API client never hands a page a raw number, even if Hermes sent one", async () => {
    const raw = "85291234567";
    const source = { source_id: "s1", channel: "whatsapp", address: raw, routes: [] };
    const mail = { source_id: "s2", channel: "email", address: "john@acme.com", routes: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes("/conflicts")
        ? { conflicts: [{ conflict_id: 1, channel: "whatsapp", address: raw, detail: null }] }
        : url.includes("/decisions")
          ? { decisions: [{ decision_id: 1, channel: "whatsapp", first_sender: `Ann <+${raw}>` }] }
          : { sources: [source, mail], source, profiles: [], is_box_admin: false };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    const client = new HermesApiClient({ baseUrl: "http://api.test" });
    const list = await client.sources();
    const shown = [
      list.sources,
      (await client.registerSource({ channel: "whatsapp", credential_ref: { kind: "wa-bridge", bridge: "john" } })).source,
      (await client.updateSource("s1", { display: "x" })).source,
      (await client.sourceConflicts(true)).conflicts,
      (await client.sourceDecisions({ sourceId: "s1" })).decisions,
    ];
    expect(JSON.stringify(shown)).not.toContain(raw);
    expect(list.sources.map((s) => s.address)).toEqual(["+85••••••67", "john@acme.com"]);
  });
});
