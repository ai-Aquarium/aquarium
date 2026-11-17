import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    has: (name: string) => jar.has(name),
    set: () => {},
  })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  hermesApiBaseUrl: () => "http://api",
}));

import { SESSION_COOKIE, serializeSession } from "@/lib/auth/session";

import { POST as quickTask } from "../projects/quick-task/route";
import { POST as dismiss } from "./[id]/dismiss/route";
import { POST as snooze } from "./[id]/snooze/route";
import { GET } from "./route";

const seen: { url: URL; init: RequestInit | undefined }[] = [];
let route: (url: URL) => Response = () => Response.json({});
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  const u = new URL(String(url));
  seen.push({ url: u, init });
  return route(u);
});

function todo(id: string, extra: Record<string, unknown> = {}) {
  return { id, ref: `D${id.slice(1)}`, title: `Do ${id}`, description: "", stage: "open", priority: "normal", source_kind: null, source_ref: null, ...extra };
}

function signIn() {
  jar.set(
    SESSION_COOKIE,
    serializeSession({
      hermesToken: "tok",
      profile: "default",
      principal: { user_id: "u1", display: "U", role: "member", channels: [], is_owner: false },
      issuedAt: 1_700_000_000,
    }),
  );
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("suggested-tasks BFF", () => {
  beforeAll(() => {
    process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
  });
  beforeEach(() => {
    jar.clear();
    seen.length = 0;
    route = () => Response.json({});
    vi.stubGlobal("fetch", fetchMock);
  });

  it("needs a session", async () => {
    expect((await GET(new Request("http://x/api/suggested-tasks"))).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("lists open and staged to-dos tagged with their source message's channel", async () => {
    signIn();
    route = (u) => {
      if (u.pathname === "/api/registry/todos") {
        return Response.json({
          items: [
            todo("t88", { source_kind: "inbound", source_ref: "m1" }),
            todo("t90", { source_kind: "inbound", source_ref: "gone" }),
            todo("t91", { source_kind: "user" }),
          ],
          next_cursor: null,
        });
      }
      if (u.pathname === "/api/registry/incomings/m1") {
        return Response.json({ id: "m1", ref: "M512", surface: "email", account_id: "sales@x", sender_name: "Ada", sender_id: "ada@x", subject: "Tender", body: "Can we submit?", occurred_at: null });
      }
      return Response.json({ detail: "No such item" }, { status: 404 });
    };
    const res = await GET(new Request("http://x/api/suggested-tasks"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(seen[0].url.searchParams.get("stage")).toBe("open,staged");
    expect(body.items.map((t: { channel: string }) => t.channel)).toEqual(["email", "other", "other"]);
    expect(body.items[0].source).toMatchObject({ id: "m1", sender_name: "Ada", subject: "Tender" });
    expect(body.items[1].source).toBeNull();
    // The user's own to-do has no arrival to read.
    expect(seen.map((s) => s.url.pathname)).not.toContain("/api/registry/incomings/null");
  });

  it("only widens the stages for one message's lookup", async () => {
    signIn();
    route = () => Response.json({ items: [], next_cursor: null });
    await GET(new Request("http://x/api/suggested-tasks?stage=working,done"));
    expect(seen[0].url.searchParams.get("stage")).toBe("open,staged");
    await GET(new Request("http://x/api/suggested-tasks?source_ref=m1&stage=open,working,done"));
    expect(seen[1].url.searchParams.get("stage")).toBe("open,working");
    expect(seen[1].url.searchParams.get("source_ref")).toBe("m1");
  });

  it("snoozes until the time asked and refuses a missing one", async () => {
    signIn();
    route = () => Response.json(todo("t1"));
    const bad = await snooze(new Request("http://x", { method: "POST", body: "{}" }), params("t1"));
    expect(bad.status).toBe(400);
    expect(seen).toHaveLength(0);
    const until = "2026-11-18T01:00:00.000Z";
    const ok = await snooze(new Request("http://x", { method: "POST", body: JSON.stringify({ until }) }), params("t1"));
    expect(ok.status).toBe(200);
    expect(seen[0].url.pathname).toBe("/api/registry/todos/t1/snooze");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ until });
  });

  it("dismisses through the audited stage move", async () => {
    signIn();
    route = () => Response.json(todo("t1", { stage: "dismissed" }));
    const res = await dismiss(new Request("http://x", { method: "POST" }), params("t1"));
    expect(res.status).toBe(200);
    expect(seen[0].url.pathname).toBe("/api/registry/todos/t1/stage");
    expect(JSON.parse(String(seen[0].init?.body))).toMatchObject({ stage: "dismissed" });
  });

  it("passes a refusal through", async () => {
    signIn();
    route = () => Response.json({ detail: "No such to-do" }, { status: 404 });
    const res = await dismiss(new Request("http://x", { method: "POST" }), params("t1"));
    expect(res.status).toBe(404);
    expect((await res.json()).detail).toBe("No such to-do");
  });
});

describe("POST /api/projects/quick-task with from_todo", () => {
  beforeEach(() => {
    jar.clear();
    seen.length = 0;
    route = () => Response.json({ id: "p1", slug: "reply-to-ada", created: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("starts the to-do's task in Manual without needing a request or profile", async () => {
    signIn();
    const res = await quickTask(
      new Request("http://x", { method: "POST", body: JSON.stringify({ from_todo: { id: "t88" } }) }),
    );
    expect(res.status).toBe(200);
    expect(seen[0].url.pathname).toBe("/api/registry/projects/quick-task");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({
      from_todo: { id: "t88" },
      autonomy: "manual",
      check_plan_first: false,
    });
  });

  it("forwards the person's own wording when given", async () => {
    signIn();
    await quickTask(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ from_todo: { id: "t88" }, request: "  Reply yes  ", autonomy: "supervised" }),
      }),
    );
    expect(JSON.parse(String(seen[0].init?.body))).toMatchObject({
      from_todo: { id: "t88" },
      request: "Reply yes",
      autonomy: "supervised",
    });
  });

  it("still needs a request and a profile without a to-do", async () => {
    signIn();
    const res = await quickTask(new Request("http://x", { method: "POST", body: JSON.stringify({ from_todo: {} }) }));
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
