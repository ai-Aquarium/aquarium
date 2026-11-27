import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal, Role } from "@/types";

const state = vi.hoisted(() => ({ role: "owner" as Role }));

vi.mock("@/i18n/server", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const settings = (await import("@/i18n/messages/en/settings.json")).default;
  return { getT: async (ns: string) => createTranslator({ settings }, ns) };
});
vi.mock("@/components/MobileShell", () => ({
  MobileShell: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async (): Promise<Principal> => ({
    user_id: "u1",
    display: "U",
    role: state.role,
    channels: [],
    is_owner: state.role === "owner",
  }),
}));

import Page from "./page";

async function viewProps() {
  const tree = (await Page()) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
  return tree.props.children.props;
}

describe("Settings index access", () => {
  beforeEach(() => {
    state.role = "owner";
  });

  it("tells the view the caller is the owner, so owner-only tiles (Name and logo, Accounts) show", async () => {
    expect(await viewProps()).toMatchObject({ canManageMembers: true, isOwner: true });
  });

  it("an admin manages members but is not the owner", async () => {
    state.role = "admin";
    expect(await viewProps()).toMatchObject({ canManageMembers: true, isOwner: false });
  });
});
