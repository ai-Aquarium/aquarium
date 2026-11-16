// @vitest-environment jsdom
/**
 * A project card's proposed message (`hermes projects propose-send`) shows,
 * before anything is sent, who it goes to, which account it leaves from, the
 * subject, the body and the attachment — and only Approve and send sends it.
 */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => router,
}));

import { describeOutbound } from "@/components/projects/CardApprovals";
import { CardDetailView } from "@/components/projects/CardDetailView";
import type { ProjectCardDetail } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

const SEND = {
  key: "send:4f2a9c1b7d3e",
  label: "Send email to ap@client.example from acme",
  detail: JSON.stringify({
    kind: "outbound_send",
    channel: "email",
    target: "ap@client.example",
    account: "acme",
    subject: "Invoice INV-0042",
    body: "Hi,\nPlease find November's invoice attached.",
    attachment: { name: "INV-0042.pdf", size: 48213, sha256: "ab" },
  }),
  requested_at: 1,
};

function blocked(): ProjectCardDetail {
  return {
    id: "t_inv",
    title: "Draft the November invoice",
    body: null,
    status: "blocked",
    assignee: "default",
    priority: 0,
    created_at: 1,
    started_at: null,
    completed_at: null,
    tenant: null,
    project_id: "prj_22",
    result: null,
    current_step_key: null,
    block_kind: "needs_input",
    latest_summary: "Approval needed: send the November invoice.",
    comments: [],
    pending_approvals: [SEND],
  } as ProjectCardDetail;
}

function row(view: ReturnType<typeof render>): HTMLElement {
  return view.container.querySelector('[data-component="CardApproval"]') as HTMLElement;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("describeOutbound", () => {
  it("reads the proposed message, and nothing from other approvals", () => {
    expect(describeOutbound(SEND)).toEqual({
      channel: "email",
      target: "ap@client.example",
      account: "acme",
      subject: "Invoice INV-0042",
      body: "Hi,\nPlease find November's invoice attached.",
      attachment: { name: "INV-0042.pdf", size: 48213 },
    });
    expect(describeOutbound({ ...SEND, key: "terminal" })).toBeNull();
    expect(describeOutbound({ ...SEND, detail: '{"kind":"other"}' })).toBeNull();
    expect(
      describeOutbound({ ...SEND, detail: SEND.detail.replace(/"attachment":\{[^}]*\}/, '"attachment":null') })
        ?.attachment,
    ).toBeNull();
  });
});

describe("a proposed message on the card", () => {
  it("shows recipient, account, subject, body and attachment before approving", () => {
    const view = render(<CardDetailView slug="p22" card={blocked()} />);
    const r = within(row(view));
    expect(r.getByText("Waiting on you: send this email?")).toBeTruthy();
    const field = (name: string) =>
      row(view).querySelector(`[data-field="${name}"]`)?.textContent;
    expect(field("to")).toBe("ap@client.example");
    expect(field("from")).toBe("acme");
    expect(field("subject")).toBe("Invoice INV-0042");
    expect(field("attachment")).toBe("INV-0042.pdf (47 KB)");
    expect(row(view).querySelector('[data-component="OutboundBody"]')?.textContent).toBe(
      "Hi,\nPlease find November's invoice attached.",
    );
    expect(r.getByText("Approve and send")).toBeTruthy();
    expect(r.queryByText("Allow on this card")).toBeNull();
  });

  it("Approve and send posts approve once", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="p22" card={blocked()} />);
    const send = within(row(view)).getByText("Approve and send");
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/p22/cards/t_inv/approvals");
    expect(JSON.parse(String(init.body))).toEqual({ key: SEND.key, decision: "approve" });
  });

  it("Revise sends the draft back with a note, which it requires", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="p22" card={blocked()} />);
    await act(async () => {
      fireEvent.click(within(row(view)).getByText("Revise…"));
    });
    const back = within(row(view)).getByText("Send back with note").closest("button")!;
    expect(back.disabled).toBe(true);
    fireEvent.change(within(row(view)).getByLabelText("What should change"), {
      target: { value: "Add PO 7781" },
    });
    await act(async () => {
      fireEvent.click(back);
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      key: SEND.key,
      decision: "revise",
      note: "Add PO 7781",
    });
  });

  it("Deny posts deny", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="p22" card={blocked()} />);
    await act(async () => {
      fireEvent.click(within(row(view)).getByText("Deny"));
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ key: SEND.key, decision: "deny" });
  });

  it("says so when the send failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okJson({ ...blocked(), outbound: { event: "failed", error: "SMTP down" } }),
      ),
    );
    const view = render(<CardDetailView slug="p22" card={blocked()} />);
    await act(async () => {
      fireEvent.click(within(row(view)).getByText("Approve and send"));
    });
    expect(within(row(view)).getByRole("alert").textContent).toContain("Not sent: SMTP down");
  });

  it("says so when only the text went out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okJson({ ...blocked(), outbound: { event: "partial", error: "WhatsApp media error (500)" } }),
      ),
    );
    const view = render(<CardDetailView slug="p22" card={blocked()} />);
    await act(async () => {
      fireEvent.click(within(row(view)).getByText("Approve and send"));
    });
    const alert = within(row(view)).getByRole("alert").textContent ?? "";
    expect(alert).toContain("Partly sent");
    expect(alert).toContain("WhatsApp media error (500)");
  });

  it("an archived project shows the message but no buttons", () => {
    const view = render(<CardDetailView slug="p22" archived card={blocked()} />);
    expect(row(view).querySelector('[data-field="to"]')?.textContent).toBe("ap@client.example");
    expect(view.queryByText("Approve and send")).toBeNull();
  });
});
