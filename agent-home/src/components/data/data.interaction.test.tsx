// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/data/s1" }));

import { DataList } from "@/components/data/DataList";
import { DictionaryDetail } from "@/components/data/DictionaryDetail";
import { ReviewDraft } from "@/components/data/ReviewDraft";
import { ShareSheet } from "@/components/data/ShareSheet";
import { BuildSheet } from "@/components/data/BuildSheet";
import { toDbInput } from "@/components/data/DbConnections";
import { DataSourceDetail } from "@/components/data/DataSourceDetail";
import { fieldDiff, healthOf, searchEntries, textToColumns } from "@/components/data/format";
import type { DataSource, DataSourceDoc, DictionaryEntry } from "@/types/data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.values(router).forEach((f) => f.mockReset());
});

const ENTRY: DictionaryEntry = { meaning: "Orders", row: "One order", grain: "order", columns: { amount: "HKD" }, joins: [], metrics: [], examples: [] };

function source(over: Partial<DataSource> = {}): DataSource {
  return { id: "s1", kind: "site", name: "Shop", owner_user_id: "leo", site_id: "x", access: "manage", status: "draft", approved_version: 1, tables_described: 1, draft_version: 2, draft_changes: 1, ...over };
}

function doc(access: DataSource["access"]): DataSourceDoc {
  return {
    source: source({ access }),
    approved: { version: 1, status: "approved", based_on: null, changes: [], proposed_by: "leo", proposed_at: null, approved_by: "leo", approved_at: null, entries: { tables: { orders: ENTRY }, glossary: [] } },
    draft: {
      version: 2, status: "draft", based_on: 1, proposed_by: "ken", proposed_at: null, approved_by: null, approved_at: null,
      changes: [{ table: "orders", origin: "chat", by: "ken", note: "refunds" }, { table: "lines", origin: "study", by: "ken", note: "" }],
      entries: { tables: { orders: { ...ENTRY, meaning: "Orders, refunds excluded" }, lines: { ...ENTRY, meaning: "Order lines" } }, glossary: [] },
      changed_tables: ["lines", "orders"],
    },
  };
}

describe("data pages", () => {
  it("links managers with a draft to review, others to the source, and both to chat", () => {
    render(<DataList sources={[source(), source({ id: "s2", access: "read" })]} people={{ leo: "Leo" }} me="leo" />);
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/data/s1", "/chat?new=1&source=s1", "/data/s1/review", "/data/s2", "/chat?new=1&source=s2", "/data/s2"]);
  });

  it("filters by needs-you, mine and type, and shows connection health", () => {
    render(
      <DataList
        me="leo"
        people={{ mei: "Mei" }}
        sources={[
          source({ id: "a", name: "Shop", status: "approved", draft_version: null }),
          source({ id: "b", name: "ERP", kind: "connection", engine: "mssql", owner_user_id: "mei", access: "read", status: "approved", health: { state: "attention", detail: "login failed" } }),
          source({ id: "c", name: "Aquarium data", kind: "app", owner_user_id: "", status: "not_described" }),
        ]}
      />,
    );
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Built in")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Needs you/ }));
    expect(screen.queryByText("Shop")).toBeNull();
    expect(screen.getByText("Aquarium data")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "mssql" } });
    expect(screen.getByText("ERP")).toBeTruthy();
    expect(screen.queryByText("Shop")).toBeNull();
  });

  it("approves the draft version without rejected tables, once", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((r) => (release = r)));
    render(<ReviewDraft doc={doc("manage")} directory={[]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    const approve = screen.getByRole("button", { name: "Approve v2" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ version: 2, reject: ["lines"] });
    release(new Response("{}", { status: 200 }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/data/s1"));
  });

  it("shows proposers the draft read-only", () => {
    render(<ReviewDraft doc={doc("propose")} directory={[]} />);
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.getByText(/Only the owner or an admin/)).toBeTruthy();
  });

  it("hides edit, build and share from readers", () => {
    const d = doc("read");
    render(<DictionaryDetail doc={{ ...d, draft: undefined }} versions={[]} directory={[]} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build dictionary" })).toBeNull();
    expect(screen.getAllByText("Orders").length).toBeGreaterThan(0);
  });

  it("says the people list failed instead of claiming everyone has access", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ grants: [] }), { status: 200 }));
    render(<ShareSheet sourceId="s1" ownerId="leo" directory={[]} directoryError onClose={() => {}} />);
    expect(screen.getByText(/Couldn't load the list of people/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "People list unavailable" })).toBeTruthy();
    expect(screen.queryByText("Everyone already has access")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  });

  it("builds a schema-scoped, on-demand study request", () => {
    const d = doc("manage");
    render(<BuildSheet source={{ ...d.source, name: "ERP" }} tables={["sales.orders", "sales.lines", "hr.staff"]} onClose={() => {}} />);
    expect(screen.queryByText(/Tables not described yet/)).toBeNull();
    const open = screen.getByRole("link", { name: "Open chat" });
    const draft = new URL(open.getAttribute("href") ?? "", "http://x").searchParams.get("draft") ?? "";
    expect(draft).toContain("schemas sales, hr only");
    expect(draft).toContain("study one the first time someone asks");
    fireEvent.click(screen.getByRole("checkbox", { name: "hr" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Study on demand/ }));
    const next = new URL(screen.getByRole("link", { name: "Open chat" }).getAttribute("href") ?? "", "http://x").searchParams.get("draft") ?? "";
    expect(next).toContain("schemas sales only");
    expect(next).not.toContain("first time someone asks");
  });

  it("opens the tab from the URL and switches tabs", () => {
    render(<DataSourceDetail doc={doc("manage")} versions={[]} directory={[]} me="leo" initialTab="access" />);
    expect(screen.getByRole("tab", { name: "Access" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Dictionary/ }));
    expect(router.replace).toHaveBeenCalledWith("/data/s1?tab=dictionary", { scroll: false });
    expect(screen.getAllByText("Orders").length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Website" })).toBeTruthy();
  });

  it("searches the dictionary by meaning and column text", () => {
    expect(searchEntries({ tables: { orders: ENTRY, lines: { ...ENTRY, meaning: "Order lines", columns: { refund: "HKD back" } } }, glossary: [] }, "refund")).toEqual(["lines"]);
  });

  it("parses columns and diffs fields", () => {
    expect(textToColumns("Amount: HKD\n\nstatus")).toEqual({ amount: "HKD", status: "" });
    expect(fieldDiff(ENTRY, { ...ENTRY, grain: "line" })).toEqual([{ field: "grain", from: "order", to: "line" }]);
  });
});

describe("toDbInput", () => {
  const base = { name: "CRM", label: "", host: "db1", port: "3306", database: "crm", username: "ro", password: "pw", tls: "verify" as const, vpn: "", path: "" };
  it("builds a MySQL body and checks required fields, name, port and password", () => {
    expect(toDbInput("mysql", base, false)).toEqual({ body: { host: "db1", port: 3306, database: "crm", username: "ro", password: "pw", tls: "verify", vpn: "" } });
    expect(toDbInput("mysql", { ...base, host: " " }, false)).toEqual({ problem: "errRequired" });
    expect(toDbInput("mysql", { ...base, name: "bad/name" }, false)).toEqual({ problem: "errName" });
    expect(toDbInput("mysql", { ...base, port: "70000" }, false)).toEqual({ problem: "errPort" });
    expect(toDbInput("mysql", { ...base, password: "" }, false)).toEqual({ problem: "errPassword" });
    expect(toDbInput("mysql", { ...base, password: "" }, true)).toEqual({ body: { host: "db1", port: 3306, database: "crm", username: "ro", tls: "verify", vpn: "" } });
  });
  it("needs only a path for SQLite", () => {
    expect(toDbInput("sqlite", { ...base, path: "/srv/p.db", label: "Prices" }, false)).toEqual({ body: { label: "Prices", path: "/srv/p.db" } });
    expect(toDbInput("sqlite", { ...base, path: "" }, false)).toEqual({ problem: "errRequired" });
  });
});

describe("healthOf with Hermes' hourly check", () => {
  const conn = { id: "c", kind: "connection", name: "ERP", owner_user_id: "u", site_id: null, access: "manage" } as const;
  it("maps ok / failed / not yet checked", () => {
    expect(healthOf({ ...conn, health: { status: "ok", checked_at: "2026-11-16T10:00:00Z" } })).toEqual({ state: "ok", checked_at: "2026-11-16T10:00:00Z" });
    expect(healthOf({ ...conn, health: { status: "failed", error: "timeout", checked_at: null } })).toEqual({ state: "attention", checked_at: null, detail: "timeout" });
    expect(healthOf({ ...conn, health: { status: null } })).toEqual({ state: "untested" });
  });
});
