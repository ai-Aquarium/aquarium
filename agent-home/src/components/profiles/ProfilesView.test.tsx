// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProfileCreate } from "@/components/profiles/NewProfileDialog";
import { ProfilesView } from "@/components/profiles/ProfilesView";
import type { ProfileInfo, ProfileStats, ProfileStatsResponse } from "@/types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const P = (over: Partial<ProfileInfo>): ProfileInfo => ({
  name: "default",
  is_default: false,
  description: "",
  description_auto: false,
  model: "claude-sonnet",
  provider: "anthropic",
  has_env: true,
  skill_count: 4,
  gateway_running: false,
  ...over,
});

const PROFILES = [
  P({
    name: "default",
    is_default: true,
    description: "Main assistant",
    gateway_running: true,
    creature: "octopus",
  }),
  P({
    name: "coder",
    description: "Writes code",
    description_auto: true,
    skill_count: 1,
    creature: "narwhal",
  }),
];

const S = (over: Partial<ProfileStats>): ProfileStats => ({
  tokens: 0,
  cost_usd: 0,
  tokens_by_day: [0, 0, 0, 0, 0, 0, 0],
  chats: 0,
  messages: 0,
  chat_sources: [],
  last_active_at: null,
  skills_used: 0,
  top_skills: [],
  projects_done: 0,
  projects_running: 0,
  tasks_running: 0,
  current_task: null,
  needs_you: 0,
  channels: [],
  ...over,
});

const STATS: ProfileStatsResponse = {
  days: 30,
  generated_at: Date.now() / 1000,
  profiles: {
    default: S({
      tokens: 1_200_000,
      cost_usd: 14.8,
      tokens_by_day: [1, 2, 3, 4, 5, 6, 7],
      chats: 214,
      chat_sources: ["web", "telegram"],
      last_active_at: Date.now() / 1000 - 120,
      skills_used: 3,
      top_skills: [{ name: "web-search", uses: 9 }],
      projects_done: 21,
      projects_running: 1,
      current_task: {
        kind: "task",
        title: "summarising the Q3 board pack",
        started_at: null,
      },
      channels: ["telegram"],
    }),
    coder: S({ needs_you: 2, last_active_at: Date.now() / 1000 - 7200 }),
  },
  totals: {
    tokens: 1_200_000,
    cost_usd: 14.8,
    projects_done: 21,
    working: 1,
    needs_you: 2,
  },
};

let statsReply: () => Promise<Response>;

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("buildProfileCreate", () => {
  const base = {
    name: " smoke-x ",
    description: "",
    source: "default",
    provider: "",
    model: "",
    available: ["a", "b"],
    hubSkills: [],
  };
  it("sends keep_skills only when something was unticked", () => {
    expect(
      buildProfileCreate({
        ...base,
        startFrom: "blank",
        kept: new Set(["a", "b"]),
      }),
    ).toMatchObject({
      name: "smoke-x",
      clone_from: null,
      clone_all: false,
      keep_skills: [],
    });
    expect(
      buildProfileCreate({ ...base, startFrom: "copy", kept: new Set(["b"]) }),
    ).toMatchObject({
      clone_from: "default",
      clone_all: false,
      keep_skills: ["b"],
    });
    expect(
      buildProfileCreate({
        ...base,
        startFrom: "all",
        kept: new Set(["a", "b"]),
      }),
    ).toMatchObject({
      clone_from: "default",
      clone_all: true,
    });
  });
});

describe("ProfilesView", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    statsReply = () => reply(STATS);
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/profiles/stats")) return statsReply();
      if (url.includes("/soul")) return reply({ content: "You are kind." });
      if (url.startsWith("/api/skills/library")) {
        return reply({
          profiles: ["default", "coder"],
          skills: [
            {
              name: "a",
              description: "",
              category: "c",
              source: "builtin",
              owners: [],
              used_by: [{ profile: "coder", enabled: true }],
            },
          ],
        });
      }
      if (url.startsWith("/api/skills"))
        return reply([
          { name: "a", description: "", category: "c", enabled: true },
        ]);
      return reply({ profiles: PROFILES });
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const card = (name: string) =>
    document
      .querySelector(`[data-profile="${name}"]`)!
      .closest('[data-component="ProfileCard"]') as HTMLElement;

  it("renders a card per profile with creature, goal, status and real stats", async () => {
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    expect(
      document.querySelectorAll('[data-component="ProfileCard"]'),
    ).toHaveLength(2);
    expect(
      card("default").querySelector('[data-creature="octopus"]'),
    ).toBeTruthy();
    expect(card("coder").textContent).toContain("Narwhal · claude-sonnet");
    expect(card("default").textContent).toContain("Main assistant");
    await waitFor(() =>
      expect(card("default").textContent).toContain(
        "Now: summarising the Q3 board pack",
      ),
    );
    expect(card("default").dataset.status).toBe("working");
    expect(card("default").textContent).toContain("1.2M");
    expect(card("default").textContent).toContain("≈ $14.80");
    expect(card("default").textContent).toContain("3 / 4");
    expect(card("default").textContent).toContain("1 running");
    expect(card("default").textContent).toContain("web-search");
    expect(card("default").textContent).toContain("Web · Telegram");
    expect(card("coder").dataset.status).toBe("off");
    expect(card("coder").textContent).toContain("Last active 2h ago");
    expect(card("coder").textContent).toContain("2 need you");
    expect(
      card("default").querySelector("[data-component=Pill]")!.textContent,
    ).toBe("default");
    const summary = document.querySelector(
      '[data-component="ProfilesSummary"]',
    )!;
    expect(summary.textContent).toContain("running now");
    expect(summary.textContent).toContain("21");
    expect(
      screen.getAllByRole("button", { name: /What is Tokens · 30d\?/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen
        .getByRole("link", { name: "Profile suggestions" })
        .getAttribute("href"),
    ).toBe("/profiles/suggestions");
  });

  it("shows skeletons while stats load and an error with retry when they fail", async () => {
    let fail!: () => void;
    statsReply = () =>
      new Promise(
        (resolve) =>
          (fail = () => resolve(new Response("{}", { status: 502 }))),
      );
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    expect(
      document
        .querySelector('[data-component="ProfilesSummary"]')!
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(card("default").querySelector("[data-skeleton]")).toBeTruthy();
    fail();
    await screen.findByText("Couldn't load activity numbers");
    expect(card("default").textContent).toContain("—");
    statsReply = () => reply(STATS);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't load activity numbers")).toBeNull(),
    );
    expect(card("default").textContent).toContain("1.2M");
  });

  it("a fresh profile reads Never used and a profile with no model needs setup", async () => {
    const fresh = P({
      name: "sandbox",
      model: null,
      provider: null,
      creature: "jellyfish",
    });
    statsReply = () =>
      reply({ ...STATS, profiles: { ...STATS.profiles, sandbox: S({}) } });
    render(
      <ProfilesView
        initialProfiles={[...PROFILES, fresh]}
        providers={[]}
        error={null}
      />,
    );
    await waitFor(() =>
      expect(card("sandbox").textContent).toContain("Never used"),
    );
    expect(card("sandbox").dataset.status).toBe("setup");
    expect(card("sandbox").textContent).toContain("no usage yet");
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await screen.findByDisplayValue("You are kind.");
    expect(
      document.querySelector('[data-component="ProfileEditor"]'),
    ).toBeTruthy();
  });

  it("filters by status tab and search, and sorts by name", async () => {
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    await waitFor(() => expect(card("default").dataset.status).toBe("working"));
    const working = document.querySelector(
      '[data-filter="working"]',
    ) as HTMLButtonElement;
    expect(working.textContent).toContain("1");
    fireEvent.click(working);
    expect(working.getAttribute("aria-pressed")).toBe("true");
    expect(
      document.querySelectorAll('[data-component="ProfileCard"]'),
    ).toHaveLength(1);
    fireEvent.click(document.querySelector('[data-filter="all"]')!);
    fireEvent.change(screen.getByLabelText("Search profiles"), {
      target: { value: "web-search" },
    });
    expect(
      [...document.querySelectorAll("[data-profile]")].map((e) =>
        e.getAttribute("data-profile"),
      ),
    ).toEqual(["default"]);
    fireEvent.change(screen.getByLabelText("Search profiles"), {
      target: { value: "nothing-here" },
    });
    expect(
      document.querySelector('[data-component="ProfilesEmpty"]'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search profiles"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Sort profiles"), {
      target: { value: "name" },
    });
    expect(
      [...document.querySelectorAll("[data-profile]")].map((e) =>
        e.getAttribute("data-profile"),
      ),
    ).toEqual(["coder", "default"]);
  });

  it("uses compact rows on a phone and cards from 640px up", () => {
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    const row = document.querySelector(
      '[data-profile-row="coder"]',
    ) as HTMLElement;
    expect(row.dataset.component).toBe("ProfileRow");
    expect(row.className).toContain("sm:hidden");
    expect(card("coder").className).toMatch(/\bhidden\b.*\bsm:flex\b/);
    expect(
      document.querySelector('[data-component="ProfileGrid"]')!.className,
    ).toMatch(/sm:grid-cols-2.*lg:grid-cols-3.*xl:grid-cols-4/);
  });

  it("opening a card locks every card until the editor is open, and keeps ?open= in sync", async () => {
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    const open = document.querySelector(
      '[data-profile="coder"]',
    ) as HTMLButtonElement;
    fireEvent.click(open);
    fireEvent.click(open);
    fireEvent.click(document.querySelector('[data-profile="default"]')!);
    expect(card("coder").getAttribute("aria-busy")).toBe("true");
    expect(
      (document.querySelector('[data-profile="default"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await screen.findByDisplayValue("You are kind.");
    expect(
      document.querySelectorAll('[data-component="ProfileEditor"]'),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete…" })).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("open")).toBe(
      "coder",
    );
  });

  it("opens the editor from ?open= and saves a creature pick once", async () => {
    render(
      <ProfilesView
        initialProfiles={PROFILES}
        providers={[]}
        error={null}
        initialOpen="coder"
      />,
    );
    await screen.findByDisplayValue("You are kind.");
    const crab = document.querySelector(
      '[data-creature-option="crab"]',
    ) as HTMLButtonElement;
    fireEvent.click(crab);
    fireEvent.click(crab);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/profiles/named/coder/creature",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const puts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/creature"),
    );
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String((puts[0][1] as RequestInit).body))).toEqual({
      creature: "crab",
    });
  });

  it("the default profile cannot be renamed or deleted", async () => {
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    fireEvent.click(document.querySelector('[data-profile="default"]')!);
    await screen.findByDisplayValue("You are kind.");
    expect(screen.queryByRole("button", { name: "Rename…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    expect(screen.getByText(/Path: hidden for safety/)).toBeTruthy();
  });

  it("delete needs the profile name typed before it is sent", async () => {
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    fireEvent.click(document.querySelector('[data-profile="coder"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete…" }));
    const confirm = screen.getByRole("button", {
      name: "Delete profile",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type the profile name/i), {
      target: { value: "code" },
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type the profile name/i), {
      target: { value: "coder" },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/profiles/named/coder",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("new profile dialog walks the steps and creates with one POST", async () => {
    render(
      <ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />,
    );
    fireEvent.click(screen.getByTestId("new-profile"));
    const next = screen.getByRole("button", {
      name: "Next →",
    }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("research-helper"), {
      target: { value: "smoke-new" },
    });
    fireEvent.click(next);
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    expect(screen.getByTestId("new-profile-review").textContent).toContain(
      "smoke-new",
    );
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/profiles",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toMatchObject(
      { name: "smoke-new", clone_from: null },
    );
  });
});
