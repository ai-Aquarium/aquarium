// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPane } from "@/components/chat/ChatPane";
import { setHandOffAttachments } from "@/lib/chat/pending-attachments";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/chat?new=1&autosend=1&draft=hello&keep=1");
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("ChatPane auto-send hand-off", () => {
  it("drops the hand-off from the address bar so a reload cannot send the turn again", async () => {
    render(
      <ChatPane
        initialSessions={[]}
        initialSessionId={null}
        initialMessages={[]}
        storageEnabled={false}
        profile="default"
        initialDraft="hello"
        autoSend
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(window.location.pathname + window.location.search).toBe("/chat?keep=1");
  });

  it("sends the files attached on the landing page with the first turn", async () => {
    const file = { path: "u/p/a.pdf", name: "a.pdf", content_type: "application/pdf", size: 10 };
    setHandOffAttachments("hello", [file]);
    render(
      <ChatPane
        initialSessions={[]}
        initialSessionId={null}
        initialMessages={[]}
        storageEnabled
        profile="default"
        initialDraft="hello"
        autoSend
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit | undefined][];
    const turn = calls.find(([, init]) => typeof init?.body === "string" && init.body.includes('"message"'));
    expect(JSON.parse(String(turn?.[1]?.body)).attachments).toEqual([file]);
    // The composer does not get them a second time.
    expect(sessionStorage.getItem("agent-home:hand-off-attachments")).toBeNull();
  });
});
