// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPane } from "@/components/chat/ChatPane";
import { chatHeaderActionsRef } from "@/lib/chat/header-actions";
import type { ChatMessage, SessionSummary } from "@/types";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

const SESSIONS: SessionSummary[] = [
  {
    id: "s1",
    source: "agent-home",
    title: "Trip planning",
    preview: null,
    message_count: 2,
    started_at: 1,
    last_active: 1,
    ended_at: null,
  },
];
const MESSAGES: ChatMessage[] = [{ id: 1, role: "user", content: "hello there" }];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  push.mockReset();
  vi.unstubAllGlobals();
});

function renderPane() {
  return render(
    <ChatPane
      initialSessions={SESSIONS}
      initialSessionId="s1"
      initialMessages={MESSAGES}
      storageEnabled={false}
      profile="default"
    />,
  );
}

const sidebar = () => document.querySelector('[data-component="chat-sidebar"]');

describe("ChatPane chats sidebar", () => {
  it("collapses to a rail and expands again, remembering the choice", () => {
    const first = renderPane();
    expect(sidebar()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse chats panel" }));
    expect(sidebar()).toBeNull();
    expect(document.querySelector('[data-component="chat-sidebar-frame"]')?.getAttribute("data-collapsed")).toBe("true");
    first.unmount();

    renderPane();
    expect(sidebar()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand chats panel" }));
    expect(sidebar()).not.toBeNull();
  });

  it("opens the full-page All chats view instead of a drawer", () => {
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: /All chats/ }));
    expect(push).toHaveBeenCalledWith("/chats");
    expect(document.querySelector('[data-component="ChatsDrawer"]')).toBeNull();

    chatHeaderActionsRef.current.openChats?.();
    expect(push).toHaveBeenCalledTimes(2);
  });
});
