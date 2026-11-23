/**
 * Project chat on the streaming seam: with `projectSlug` the turn sent
 * upstream is the one the project API prepared (context / catch-up at the
 * top of the same user turn), for the picked profile's own conversation; a
 * plain turn never calls the project API.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/chat/stream/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const openChatStream = vi.fn(async (...args: [sessionId: string, message: string]) => {
  void args;
  return new Response("event: done\ndata: {}\n\n");
});
const prepareProjectChat = vi.fn(
  async (_slug: string, body: { profile: string; session_id: string; message: string }) => ({
    session_id: body.session_id,
    message: `[project chat: P1 · Digest]\nCatch-up: 2 messages\n[/project chat]\n\n${body.message}`,
    seeded: false,
    catch_up: 2,
  }),
);
const clientProfiles: (string | undefined)[] = [];

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async (opts?: { profile?: string }) => {
    clientProfiles.push(opts?.profile);
    return {
      openChatStream,
      prepareProjectChat,
      boundProfile: () =>
        opts?.profile && opts.profile !== "default" ? opts.profile : undefined,
      createSession: async () => ({ session_id: `new_${opts?.profile ?? "default"}` }),
    };
  },
}));

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://home.test/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

describe("POST /api/chat/stream projectSlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientProfiles.length = 0;
    getPrincipal.mockResolvedValue({
      user_id: "leo",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
  });

  it("sends the prepared turn into the picked profile's own conversation", async () => {
    const res = await post({ message: "Cost it out", profile: "finance", projectSlug: "digest" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-hermes-session-id")).toBe("new_finance");
    expect(prepareProjectChat).toHaveBeenCalledWith("digest", {
      profile: "finance",
      session_id: "new_finance",
      message: "Cost it out",
    });
    const [sid, message] = openChatStream.mock.calls[0];
    expect(sid).toBe("new_finance");
    expect(message.startsWith("[project chat:")).toBe(true);
    expect(message.endsWith("\n\nCost it out")).toBe(true);
    expect(openChatStream).toHaveBeenCalledTimes(1);
  });

  it("sends a document's escaped link through the project turn", async () => {
    await post({
      message: "Read this",
      profile: "finance",
      projectSlug: "digest",
      attachments: [
        { path: "leo/s1/u1-q4.pdf", name: "[Q4](final copy).pdf", content_type: "application/pdf", size: 1 },
      ],
    });
    const link = "[\\[Q4\\]\\(final copy\\).pdf](/api/chat/media?path=leo%2Fs1%2Fu1-q4.pdf)";
    expect(prepareProjectChat.mock.calls[0][1].message).toBe(`Read this\n\n${link}`);
    expect(openChatStream.mock.calls[0][1].endsWith(link)).toBe(true);
  });

  it("honours an explicit default and streams into the canonical conversation", async () => {
    prepareProjectChat.mockImplementationOnce(async (_slug, body) => ({
      session_id: "canonical_default",
      message: body.message,
      seeded: false,
      catch_up: 0,
    }));
    const res = await post({ message: "hi", profile: "default", projectSlug: "digest" });
    expect(clientProfiles[0]).toBe("default");
    expect(prepareProjectChat.mock.calls[0][1].profile).toBe("default");
    expect(openChatStream.mock.calls[0][0]).toBe("canonical_default");
    expect(res.headers.get("x-hermes-session-id")).toBe("canonical_default");
  });

  it("keeps an existing conversation and never asks the project API for a plain turn", async () => {
    await post({ message: "hi", profile: "finance", sessionId: "s1", projectSlug: "digest" });
    expect(openChatStream.mock.calls[0][0]).toBe("s1");
    vi.clearAllMocks();
    await post({ message: "hi", sessionId: "s1" });
    expect(prepareProjectChat).not.toHaveBeenCalled();
    expect(openChatStream.mock.calls[0][1]).toBe("hi");
  });
});
