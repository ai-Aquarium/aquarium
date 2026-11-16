// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourcesView } from "@/components/sources/SourcesView";
import type { SourcesList } from "@/lib/sources/api";
import type { Source, SourceClaimConflict } from "@/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/settings/sources", useSearchParams: () => new URLSearchParams() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function source(over: Partial<Source> = {}): Source {
  return {
    source_id: "s1",
    channel: "whatsapp",
    address: "+852 9123 4567",
    owner_user_id: "john",
    display: null,
    credential_ref: null,
    enabled: true,
    created_at: null,
    updated_at: null,
    routes: [
      { source_id: "s1", profile: "cfo", enabled: true, created_at: null, updated_at: null },
      { source_id: "s1", profile: "cmo", enabled: false, created_at: null, updated_at: null },
    ],
    ...over,
  };
}

const LIST: SourcesList = { sources: [source()], profiles: ["cfo", "cmo"], is_box_admin: false };

const CLAIM: SourceClaimConflict = {
  conflict_id: 7,
  channel: "email",
  address: "john@acme.com",
  claimant_user_id: "mary",
  existing_owner_user_id: "john",
  detail: "",
  created_at: null,
  resolved_at: null,
  resolution: null,
};

function mockFetch(handlers: Record<string, (init?: RequestInit) => Response>) {
  const calls: Array<[string, string]> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push([method, url]);
    const h = handlers[`${method} ${url}`];
    return h ? h(init) : new Response(JSON.stringify(LIST));
  });
  return calls;
}

describe("SourcesView", () => {
  it("shows channel badge, address and paused route chips", () => {
    render(<SourcesView initial={LIST} initialConflicts={[]} />);
    const row = screen.getByText("+852 9123 4567").closest("li")!;
    expect(within(row).getByText("WA")).toBeTruthy();
    expect(within(row).getByText("cfo").getAttribute("data-on")).toBe("true");
    expect(within(row).getByText("cmo · paused").getAttribute("data-on")).toBe("false");
    expect(within(row).getByRole("link", { name: "Recent routing" }).getAttribute("href")).toBe(
      "/settings/sources/s1/routing",
    );
  });

  it("turns a source off with one PATCH even on a double tap", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const bodies: unknown[] = [];
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      await gate;
      return new Response(JSON.stringify({ source: source({ enabled: false }) }));
    });
    render(<SourcesView initial={LIST} initialConflicts={[]} />);
    const [toggle] = screen.getAllByRole("switch", { name: "Read new messages from +852 9123 4567" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    release();
    await waitFor(() => expect(screen.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe("false"));
    expect(calls).toEqual(["PATCH /api/sources/s1"]);
    expect(bodies[0]).toEqual({ enabled: false });
  });

  it("saves only the routes that changed", async () => {
    const calls = mockFetch({
      "PUT /api/sources/s1/routes/cmo": () =>
        new Response(JSON.stringify({ route: { source_id: "s1", profile: "cmo", enabled: true, created_at: null, updated_at: null } })),
    });
    render(<SourcesView initial={LIST} initialConflicts={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit routes" }));
    const save = screen.getByRole("button", { name: "Save routes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "cmo" }));
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save routes" })).toBeNull());
    expect(calls.filter(([m]) => m === "PUT").map(([, u]) => u)).toEqual(["/api/sources/s1/routes/cmo"]);
    expect(screen.getByText("cmo").getAttribute("data-on")).toBe("true");
  });

  it("after a partial failure, a retry diffs against what the server saved", async () => {
    const route = (profile: string, enabled: boolean) =>
      new Response(JSON.stringify({ route: { source_id: "s1", profile, enabled, created_at: null, updated_at: null } }));
    const cfo: boolean[] = [];
    const calls = mockFetch({
      "PUT /api/sources/s1/routes/cfo": (init) => {
        const enabled = JSON.parse(String(init?.body)).enabled as boolean;
        cfo.push(enabled);
        return route("cfo", enabled);
      },
      "PUT /api/sources/s1/routes/cmo": () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    });
    render(<SourcesView initial={LIST} initialConflicts={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit routes" }));
    fireEvent.click(screen.getByRole("switch", { name: "cfo" }));
    fireEvent.click(screen.getByRole("switch", { name: "cmo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save routes" }));
    await waitFor(() => expect(cfo).toEqual([false]));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save routes" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("switch", { name: "cfo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save routes" }));
    await waitFor(() => expect(cfo).toEqual([false, true]));
    expect(calls.filter(([m, u]) => m === "PUT" && u.endsWith("/cmo")).length).toBe(2);
  });

  it("asks before removing, then deletes", async () => {
    const calls = mockFetch({ "DELETE /api/sources/s1": () => new Response(JSON.stringify({ deleted: true })) });
    render(<SourcesView initial={LIST} initialConflicts={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove +852 9123 4567?")).toBeTruthy();
    expect(calls.some(([m]) => m === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove source" }));
    await screen.findByText("+852 9123 4567 removed.");
    expect(calls.filter(([m]) => m === "DELETE")).toEqual([["DELETE", "/api/sources/s1"]]);
  });

  it("shows the claims banner; only admins get Keep / Give to this user", async () => {
    const calls = mockFetch({
      "POST /api/sources/conflicts/7/resolve": () =>
        new Response(JSON.stringify({ conflict: { ...CLAIM, resolved_at: "2026-11-17T00:00:00Z", resolution: "keep" } })),
    });
    const { unmount } = render(<SourcesView initial={LIST} initialConflicts={[CLAIM]} />);
    expect(screen.getByText("1 claim on your sources")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "See claims" }));
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    unmount();

    render(<SourcesView initial={{ ...LIST, is_box_admin: true }} initialConflicts={[CLAIM]} />);
    fireEvent.click(screen.getByRole("button", { name: "See claims" }));
    const keep = screen.getByRole("button", { name: "Keep" });
    fireEvent.click(keep);
    fireEvent.click(keep);
    await screen.findByText("Kept with john.");
    const posts = calls.filter(([m]) => m === "POST");
    expect(posts).toEqual([["POST", "/api/sources/conflicts/7/resolve"]]);
  });
});
