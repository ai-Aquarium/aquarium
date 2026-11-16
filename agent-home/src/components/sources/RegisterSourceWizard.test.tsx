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

  it("explains when I have no profiles and keeps Next disabled", async () => {
    mockFetch();
    render(<RegisterSourceWizard list={{ ...LIST, profiles: [] }} onClose={vi.fn()} onRegistered={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /john@acme\.com/ }));
    next();
    expect(screen.getByText("You have no profiles yet")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
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

  it("offers triage per channel only where it runs", () => {
    expect(channelHasTriage("email", false)).toBe(true);
    expect(channelHasTriage("telegram", false)).toBe(false);
    expect(channelHasTriage("telegram", true)).toBe(true);
  });
});
