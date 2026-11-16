// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TriageSkillsView } from "@/components/profiles/triage/TriageSkillsView";
import type { TriageLayeredFile, TriageLayers } from "@/types";

const TEMPLATE = "Treat invoices as finance.\nOverdue invoices → Needs You.\nIgnore newsletters.";
const MINE = "Treat invoices as finance.\nOverdue or due within 5 days → Needs You.\nIgnore newsletters.";
const DIFF = [
  "--- template/classify-emails.md",
  "+++ mine/classify-emails.md",
  "@@ -1,3 +1,3 @@",
  " Treat invoices as finance.",
  "-Overdue invoices → Needs You.",
  "+Overdue or due within 5 days → Needs You.",
  " Ignore newsletters.",
].join("\n");

const FILES: TriageLayeredFile[] = [
  { key: "classify-emails.md", layer: "user", path: null, disabled: false, layers: { template: "content", user: "content" } },
  { key: "needs-you-rules.md", layer: "template", path: null, disabled: false, layers: { template: "content" } },
  { key: "todo-format.md", layer: "builtin", path: null, disabled: false, layers: { builtin: "content" } },
  { key: "quiet.md", layer: null, path: null, disabled: true, layers: { template: "content", user: "disabled" } },
];

let canEditTemplate = true;
let calls: Array<{ url: string; method: string; body: unknown }> = [];
let hold: Promise<void> | null = null;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

function layers(kind: string): TriageLayers {
  return {
    profile: "CFO",
    kind: kind as TriageLayers["kind"],
    user_id: "u-me",
    files: FILES,
    care: {
      key: "what-i-care-about.md",
      layer: "user",
      content: "Invoices and payment requests.",
      template: { layer: "template", content: "Finance mail." },
    },
    can_edit_template: canEditTemplate,
  };
}

beforeEach(() => {
  canEditTemplate = true;
  calls = [];
  hold = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(input), method, body });
      const url = new URL(String(input), "http://x");
      const q = Object.fromEntries(url.searchParams);
      if (method !== "GET") {
        if (hold) await hold;
        if (url.pathname.endsWith("/care")) {
          return json({ ok: true, kind: body.kind, layer: "user", care: { key: "what-i-care-about.md", layer: "user", content: body.content } });
        }
        return json({ ok: true, kind: body.kind, layer: "user", key: body.key, reset: [body.key] });
      }
      if (url.pathname === "/api/triage/layers") return json(layers(q.kind));
      if (url.pathname.endsWith("/file")) {
        const content = q.layer === "user" ? MINE : q.layer === "template" ? TEMPLATE : "built-in text";
        return json({ kind: q.kind, key: q.key, layer: q.layer, requested_layer: q.layer, state: "content", content });
      }
      if (url.pathname.endsWith("/diff")) {
        return json({ kind: q.kind, key: q.key, template_disabled: false, mine_disabled: false, changed: true, diff: DIFF });
      }
      if (url.pathname.endsWith("/history")) {
        return json({
          kind: q.kind,
          key: q.key,
          layer: q.layer,
          versions:
            q.layer === "user"
              ? [{ id: "1", at: Date.now() / 1000 - 60, author: "user:u-me", action: "edit", message: "Due within 5 days", content: MINE }]
              : [],
        });
      }
      return json({ detail: "not found" }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  const view = render(<TriageSkillsView profile="CFO" initialKind="email" />);
  await screen.findByText("classify-emails.md", { selector: "h2" });
  await screen.findByText("History · my version");
  return view;
}

const row = (key: string) => document.querySelector(`li[data-file="${key}"]`) as HTMLElement;

describe("TriageSkillsView", () => {
  it("shows the four tabs, which layer wins per file, and template beside mine", async () => {
    await renderPage();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Email", "WhatsApp", "Telegram", "Calendar"]);
    expect(row("classify-emails.md").querySelector("[data-layer]")?.textContent).toBe("Mine");
    expect(row("needs-you-rules.md").querySelector("[data-layer]")?.textContent).toBe("Template");
    expect(row("todo-format.md").querySelector("[data-layer]")?.textContent).toBe("Built-in");
    expect(row("quiet.md").querySelector("[data-layer]")?.textContent).toBe("Off");

    const side = document.querySelector('[data-slot="side-by-side"]') as HTMLElement;
    const template = side.querySelector('[data-panel="Template"]') as HTMLElement;
    const mine = side.querySelector('[data-panel="Mine"]') as HTMLElement;
    expect(template.querySelector('[data-op="del"]')?.textContent).toBe("- Overdue invoices → Needs You.");
    expect(template.querySelector('[data-op="add"]')).toBeNull();
    expect(mine.querySelector('[data-op="add"]')?.textContent).toBe("+ Overdue or due within 5 days → Needs You.");
    const unified = document.querySelector('[data-slot="unified"]') as HTMLElement;
    expect(unified.querySelectorAll('[data-op="del"]')).toHaveLength(1);
    expect(unified.querySelectorAll('[data-op="add"]')).toHaveLength(1);
    expect(within(unified).queryByText(/template\/classify-emails/)).toBeNull();
  });

  it("only ever reads my own layer, bound to the profile", async () => {
    await renderPage();
    for (const c of calls) {
      expect(c.url.startsWith("/api/triage/layers")).toBe(true);
      expect(c.url).toContain("profile=CFO");
      expect(c.url).not.toMatch(/user_id|user=/);
    }
    const userReads = calls.filter((c) => c.url.includes("layer=user"));
    expect(userReads.length).toBeGreaterThan(0);
  });

  it("offers Edit template to owners and a read-only note to everyone else", async () => {
    await renderPage();
    expect(screen.getByRole("button", { name: "Edit template" })).toBeTruthy();
    cleanup();
    canEditTemplate = false;
    await renderPage();
    expect(screen.queryByRole("button", { name: "Edit template" })).toBeNull();
    expect(screen.getByText("The CFO template is read-only for you")).toBeTruthy();
  });

  it("requires care text, uses the template's text, and saves my layer once per click burst", async () => {
    await renderPage();
    const box = screen.getByLabelText("What I care about");
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.change(box, { target: { value: "   " } });
    expect(screen.getByText(/Required: write a line/)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Use template text" }));
    expect((box as HTMLTextAreaElement).value).toBe("Finance mail.");

    let release!: () => void;
    hold = new Promise((r) => (release = r));
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(save.getAttribute("aria-busy")).toBe("true"));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await screen.findByText(/Saved\. The next batch/);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toEqual([{ url: "/api/triage/layers/care?profile=CFO", method: "PUT", body: { kind: "email", layer: "user", content: "Finance mail." } }]);
  });

  it("turns a file off for me from the list", async () => {
    await renderPage();
    fireEvent.click(within(row("needs-you-rules.md")).getByRole("switch"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      url: "/api/triage/layers/disable?profile=CFO",
      body: { kind: "email", layer: "user", key: "needs-you-rules.md", disabled: true },
    });
  });

  it("resets to the template only after confirming", async () => {
    await renderPage();
    const view = document.querySelector('[data-component="TriageFileView"]') as HTMLElement;
    fireEvent.click(within(view).getByRole("button", { name: "Reset to template" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reset classify-emails.md to the template?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(within(view).getByRole("button", { name: "Reset to template" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset to template" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        url: "/api/triage/layers/reset?profile=CFO",
        body: { kind: "email", key: "classify-emails.md" },
      }),
    );
  });

  it("asks before a tab switch drops unsaved text, then loads the new kind", async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText("What I care about"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("tab", { name: "Telegram" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Discard unsaved changes?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/triage/layers?kind=telegram"))).toBe(true));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Telegram" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("edits my version and adds a file only I get", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit my version" }));
    const editor = screen.getByLabelText("My version") as HTMLTextAreaElement;
    expect(editor.value).toBe(MINE);
    fireEvent.change(editor, { target: { value: `${MINE}\nKowloon Freight: always a to-do.` } });
    fireEvent.click(screen.getByRole("button", { name: "Save my version" }));
    await screen.findByText("Saved. Your version of classify-emails.md now wins.");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      kind: "email",
      layer: "user",
      key: "classify-emails.md",
      content: `${MINE}\nKowloon Freight: always a to-do.`,
    });

    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
    const sheet = await screen.findByRole("dialog");
    const add = within(sheet).getByRole("button", { name: "Add file" }) as HTMLButtonElement;
    fireEvent.change(within(sheet).getByLabelText("File name"), { target: { value: "classify-emails" } });
    expect(within(sheet).getByText(/already exists/)).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText("File name"), { target: { value: "vip" } });
    fireEvent.change(within(sheet).getByLabelText("What it says"), { target: { value: "VIPs are Needs You." } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PUT").pop()?.body).toEqual({
        kind: "email",
        layer: "user",
        key: "vip.md",
        content: "VIPs are Needs You.",
      }),
    );
  });
});
