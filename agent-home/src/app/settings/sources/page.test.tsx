import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HermesApiError } from "@/lib/api/client";
import type { MyProfile } from "@/types";

const state = vi.hoisted(() => ({
  sessionProfile: "default",
  mine: [] as MyProfile[],
  sourcesError: null as Error | null,
  reads: [] as (string | undefined)[],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/sources",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/server", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const sources = (await import("@/i18n/messages/en/sources.json")).default;
  return { getT: async (ns: string) => createTranslator({ sources }, ns) };
});
vi.mock("@/components/MobileShell", () => ({
  MobileShell: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) =>
    createElement("div", null, createElement("header", null, actions), children),
}));
vi.mock("@/lib/auth/session", () => ({
  readSession: async () => ({ profile: state.sessionProfile }),
}));
vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async () => ({ user_id: "mary", display: "Mary", role: "member", channels: [], is_owner: false }),
  apiClientForRequest: async (opts: { profile?: string } = {}) => ({
    sources: async () => {
      state.reads.push(opts.profile);
      if (state.sourcesError) throw state.sourcesError;
      return { sources: [], profiles: ["default"], is_box_admin: false };
    },
    sourceConflicts: async () => ({ conflicts: [] }),
    myProfiles: async () => ({ profiles: state.mine }),
  }),
}));

import Page from "./page";

const SUSPENDED = new HermesApiError(403, "This enrolment has been suspended in the current profile.");
const html = async () => renderToStaticMarkup((await Page()) as ReactElement);
const enrol = (name: string, active: boolean): MyProfile => ({ name, role: "member", active, is_default: name === "default" });

beforeEach(() => {
  state.sessionProfile = "default";
  state.mine = [];
  state.sourcesError = null;
  state.reads = [];
});

describe("Settings › Sources page", () => {
  it("with no active enrolment anywhere shows the no-profiles explanation and keeps Register", async () => {
    state.sourcesError = SUSPENDED;
    state.mine = [enrol("default", false), enrol("finance", false)];
    const out = await html();
    expect(out).toContain("You have no profiles yet");
    expect(out).toContain("Ask an admin");
    expect(out).toContain('data-action="register-source"');
    expect(out).not.toContain("The bowl needs a moment");
    // Hermes still refused: the only read was the session's own (refused) one.
    expect(state.reads).toEqual([undefined]);
  });

  it("with the session's profile suspended but others active, offers a switch instead of an error", async () => {
    state.sourcesError = SUSPENDED;
    state.mine = [enrol("default", false), enrol("finance", true)];
    const out = await html();
    expect(out).toContain("Your enrolment in default is suspended");
    expect(out).toContain("Switch to finance");
    expect(out).not.toContain('data-action="register-source"');
    expect(state.reads).toEqual([undefined]);
  });

  it("keeps the generic error for any other failure", async () => {
    state.sourcesError = new HermesApiError(503, "Hermes is restarting");
    state.mine = [enrol("default", true)];
    const out = await html();
    expect(out).toContain('data-component="SourcesError"');
    expect(out).not.toContain("You have no profiles yet");
  });

  it("keeps the generic error for a 403 in a profile I'm active in", async () => {
    state.sourcesError = new HermesApiError(403, "Forbidden");
    state.mine = [enrol("default", true)];
    expect(await html()).toContain('data-component="SourcesError"');
  });
});
