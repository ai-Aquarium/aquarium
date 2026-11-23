// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AllChatsView } from "@/components/chat/AllChatsView";
import type { SessionSummary } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const session = (id: string, title: string): SessionSummary => ({
  id,
  source: "agent-home",
  title,
  preview: null,
  message_count: 2,
  started_at: 1,
  last_active: 1,
  ended_at: null,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AllChatsView", () => {
  it("lists every chat as a page-wide grid with no All chats button", () => {
    render(<AllChatsView profile="default" initialSessions={[session("a", "Trip planning"), session("b", "Budget")]} />);
    const panel = document.querySelector('[data-component="ChatsPanel"]');
    expect(panel?.getAttribute("data-layout")).toBe("page");
    expect(panel?.querySelector("ul")?.className).toContain("grid");
    expect(screen.getByText("Trip planning")).toBeTruthy();
    expect(screen.getByText("Budget")).toBeTruthy();
    expect(document.querySelector('[data-component="AllChatsButton"]')).toBeNull();
  });
});
