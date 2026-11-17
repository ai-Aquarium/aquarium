// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegisterSourceWizard, channelHasTriage } from "@/components/sources/RegisterSourceWizard";
import type { SourcesList } from "@/lib/sources/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LIST: SourcesList = { sources: [], profiles: ["cfo", "cmo"], is_box_admin: false };

type Call = { method: string; url: string; body: unknown };

function mockFetch(over: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const key = `${method} ${url}`;
    if (over[key]) return over[key]();
    if (url === "/api/email/mailboxes")
      return new Response(JSON.stringify({ mailboxes: [{ address: "john@acme.com", state: "working" }] }));
    if (url === "/api/wa-bridges") return new Response(JSON.stringify({ bridges: [] }));
    if (url === "/api/telegram-bot")
      return new Response(JSON.stringify({ configured: true, linked: true, bot_username: "JohnAcmeBot", last_test_ok: true }));
    if (url.startsWith("/api/triage/layers?")) return new Response(JSON.stringify({ care: { content: "Template care" } }));
    if (key === "POST /api/sources")
      return new Response(JSON.stringify({ source: { source_id: "s9", routes: [] } }));
    if (method === "PUT") return new Response(JSON.stringify({ ok: true, route: {} }));
    return new Response("{}");
  });
  return calls;
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));

async function pickEmailAndProfiles(profiles: string[]) {
  fireEvent.click(await screen.findByRole("radio", { name: /john@acme\.com/ }));
  next();
  for (const p of profiles) fireEvent.click(screen.getByRole("checkbox", { name: p }));
  next();
}

describe("RegisterSourceWizard", () => {
  it("keeps Next disabled until an account is picked and Back on step 1 closes", async () => {
    mockFetch();
    const onClose = vi.fn();
    render(<RegisterSourceWizard list={LIST} onClose={onClose} onRegistered={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole("radio", { name: /john@acme\.com/ }));
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("link", { name: /Connect a new mailbox/ }).getAttribute("href")).toBe("/settings/in-out");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("registers once, routes each picked profile and saves care in that profile", async () => {
    const calls = mockFetch();
    const onRegistered = vi.fn();
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={onRegistered} />);
    await pickEmailAndProfiles(["cfo", "cmo"]);
    fireEvent.click(screen.getAllByRole("radio", { name: /View and change/ })[1]);
    const care = (await screen.findByDisplayValue("Template care")) as HTMLTextAreaElement;
    expect(calls.some((c) => c.url === "/api/triage/layers?kind=email&profile=cmo")).toBe(true);
    fireEvent.change(care, { target: { value: "Campaign briefs" } });
    next();
    expect(screen.getByText("cfo: template · cmo: my version (What I care about edited)")).toBeTruthy();
    const register = screen.getByRole("button", { name: "Register" });
    fireEvent.click(register);
    fireEvent.click(register);
    await waitFor(() => expect(onRegistered).toHaveBeenCalled());
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/sources",
      "PUT /api/sources/s9/routes/cfo",
      "PUT /api/sources/s9/routes/cmo",
      "PUT /api/triage/layers/care?profile=cmo",
    ]);
    expect(writes[0].body).toEqual({
      channel: "email",
      address: "john@acme.com",
      display: null,
      credential_ref: { kind: "email-imap", name: "john@acme.com" },
    });
    expect(writes[3].body).toEqual({ kind: "email", layer: "user", content: "Campaign briefs" });
    expect(onRegistered).toHaveBeenCalledWith({ tone: "success", text: "john@acme.com registered." });
  });

  it("shows the claim conflict from registerSource and adds no routes", async () => {
    const calls = mockFetch({
      "POST /api/sources": () => new Response(JSON.stringify({ detail: "owned" }), { status: 409 }),
    });
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={vi.fn()} />);
    await pickEmailAndProfiles(["cfo"]);
    next();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText(/already a source of another person/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ask an admin" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("names the current owner on the claim conflict when Hermes gives a display name", async () => {
    mockFetch({
      "POST /api/sources": () =>
        new Response(JSON.stringify({ detail: "owned", owner_display: "Mary" }), { status: 409 }),
    });
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={vi.fn()} />);
    await pickEmailAndProfiles(["cfo"]);
    next();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText(/already a source of another person \(Mary\)/)).toBeTruthy();
  });

  it("shows my role in each profile on the Profiles step", async () => {
    mockFetch();
    render(
      <RegisterSourceWizard
        list={{ ...LIST, profile_roles: { cfo: "owner", cmo: "member" } }}
        onClose={vi.fn()}
        onRegistered={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("radio", { name: /john@acme\.com/ }));
    next();
    expect(screen.getAllByTestId("profile-role").map((el) => el.textContent)).toEqual(["Owner", "Member"]);
    expect(screen.getByRole("checkbox", { name: /cfo/ })).toBeTruthy();
  });

  it("explains an unpaired WhatsApp bridge in plain words and links to its setup", async () => {
    const calls = mockFetch({
      "GET /api/wa-bridges": () =>
        new Response(JSON.stringify({ bridges: [{ name: "john-wa", paired: true, number: "+85••••••67", status: "connected" }] })),
      "POST /api/sources": () =>
        new Response(JSON.stringify({ detail: "This WhatsApp bridge is not linked to a phone yet." }), { status: 409 }),
    });
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /WhatsApp/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /\+85•{6}67/ }));
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "cfo" }));
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect((await screen.findByTestId("register-error")).textContent).toMatch(/isn't linked to a phone yet\. Scan the QR code/);
    expect(screen.getByRole("link", { name: "Open In&Out settings" }).getAttribute("href")).toBe("/settings/in-out");
    expect(screen.queryByRole("link", { name: "Ask an admin" })).toBeNull();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("with no profiles opens on the Profiles step, explains, offers Ask an admin and reads no accounts", async () => {
    const calls = mockFetch();
    const onClose = vi.fn();
    render(<RegisterSourceWizard list={{ ...LIST, profiles: [] }} onClose={onClose} onRegistered={vi.fn()} />);
    expect(screen.getByText("You have no profiles yet")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    const ask = screen.getByRole("button", { name: "Ask an admin" });
    fireEvent.click(ask);
    expect(ask.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("ask-admin-hint").textContent).toMatch(/add you to a profile/);
    expect(calls.filter((c) => c.url.startsWith("/api/email") || c.url.startsWith("/api/wa") || c.url.startsWith("/api/telegram"))).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a failed account endpoint as an error with one Try again, not as no accounts", async () => {
    let mailboxes = 0;
    let release: () => void = () => undefined;
    const calls = mockFetch({
      "GET /api/email/mailboxes": () => {
        mailboxes += 1;
        return new Response(JSON.stringify({ detail: "unavailable" }), { status: 503 });
      },
    });
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={vi.fn()} />);
    const failed = await screen.findByTestId("accounts-failed");
    expect(failed.textContent).toMatch(/Couldn't check your mailboxes/);
    expect(screen.queryByTestId("accounts-empty")).toBeNull();
    expect(screen.getByRole("link", { name: /Connect a new mailbox/ })).toBeTruthy();

    // The retry is single-flight: a second click while it runs sends nothing.
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      calls.push({ method: "GET", url, body: null });
      if (url === "/api/email/mailboxes") {
        mailboxes += 1;
        await new Promise<void>((r) => (release = r));
        return new Response(JSON.stringify({ mailboxes: [{ address: "john@acme.com", state: "working" }] }));
      }
      return new Response("{}");
    });
    const retry = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
    expect(mailboxes).toBe(2);
    release();
    fireEvent.click(await screen.findByRole("radio", { name: /john@acme\.com/ }));
    expect(screen.queryByTestId("accounts-failed")).toBeNull();
  });

  it("keeps each channel's failure separate and says 'not yet' for a genuine empty one", async () => {
    mockFetch({
      "GET /api/telegram-bot": () => new Response(JSON.stringify({ detail: "down" }), { status: 503 }),
    });
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={vi.fn()} />);
    expect(await screen.findByRole("radio", { name: /john@acme\.com/ })).toBeTruthy();
    expect(screen.queryByTestId("accounts-failed")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /WhatsApp/ }));
    expect(screen.getByTestId("accounts-empty").textContent).toMatch(/haven't connected a WhatsApp number yet/);
    expect(screen.queryByTestId("accounts-failed")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Telegram/ }));
    expect(screen.getByTestId("accounts-failed").getAttribute("data-channel")).toBe("telegram");
  });

  it("with Telegram triage off: warns, offers no triage choice and saves no care", async () => {
    const calls = mockFetch();
    const onRegistered = vi.fn();
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={onRegistered} />);
    fireEvent.click(screen.getByRole("radio", { name: /Telegram bot/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /@JohnAcmeBot/ }));
    expect(screen.getByText(/Telegram triage is switched off\. You can register @JohnAcmeBot/)).toBeTruthy();
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "cfo" }));
    next();
    expect(screen.queryByRole("radio", { name: /View and change/ })).toBeNull();
    expect(screen.getByText(/triage\.agent\.telegram in config\.yaml/)).toBeTruthy();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(onRegistered).toHaveBeenCalled());
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([
      "/api/sources",
      "/api/sources/s9/routes/cfo",
    ]);
  });

  it("registers a WhatsApp bridge by credential only and reports the address Hermes derived", async () => {
    const calls = mockFetch({
      "GET /api/wa-bridges": () =>
        new Response(JSON.stringify({ bridges: [{ name: "john-wa", paired: true, number: "+85••••••67", status: "connected" }] })),
      "POST /api/sources": () =>
        new Response(JSON.stringify({ source: { source_id: "s9", address: "85291234567", routes: [] } })),
    });
    const onRegistered = vi.fn();
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={onRegistered} />);
    fireEvent.click(screen.getByRole("radio", { name: /WhatsApp/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /\+85•{6}67/ }));
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "cfo" }));
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(onRegistered).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      channel: "whatsapp",
      display: "john-wa",
      credential_ref: { kind: "wa-bridge", bridge: "john-wa" },
    });
    expect(onRegistered.mock.calls[0][0].text).toContain("+85••••••67");
    expect(onRegistered.mock.calls[0][0].text).not.toContain("85291234567");
  });

  it("keeps my existing version instead of claiming the template, and checks the 4 KB byte limit", async () => {
    mockFetch({
      "GET /api/triage/layers?kind=email&profile=cfo": () =>
        new Response(JSON.stringify({ care: { key: "care", layer: "user", content: "Invoices only" } })),
    });
    render(<RegisterSourceWizard list={LIST} onClose={vi.fn()} onRegistered={vi.fn()} />);
    await pickEmailAndProfiles(["cfo", "cmo"]);
    expect(await screen.findByRole("radio", { name: /Keep my version/ })).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /Use the template's triage skills/ }).length).toBe(1);
    fireEvent.click(screen.getAllByRole("radio", { name: /View and change/ })[1]);
    const care = (await screen.findByDisplayValue("Template care")) as HTMLTextAreaElement;
    fireEvent.change(care, { target: { value: "發".repeat(1400) } });
    expect(screen.getByRole("alert").textContent).toContain("4200 / 4096");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(care, { target: { value: "Campaign briefs" } });
    next();
    expect(screen.getByText("cfo: my version (kept) · cmo: my version (What I care about edited)")).toBeTruthy();
  });

  it("offers triage per channel only where it runs", () => {
    expect(channelHasTriage("email", false)).toBe(true);
    expect(channelHasTriage("telegram", false)).toBe(false);
    expect(channelHasTriage("telegram", true)).toBe(true);
  });
});
