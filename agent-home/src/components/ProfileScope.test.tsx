// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh }),
}));

import { ProfileScope } from "@/components/ProfileScope";

/** A profile-scoped list that, like TodosList, copies its server props into state once. */
function Rows({ initial }: { initial: string[] }) {
  const [rows] = useState(initial);
  return <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>;
}

beforeEach(() => {
  nav.replace.mockReset();
  nav.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  nav.search = "";
});

function setUrl(path: string) {
  window.history.replaceState(null, "", path);
  nav.search = new URL(path, "http://x").search;
}

describe("ProfileScope", () => {
  it("switches to the linked profile before showing anything, then drops ?profile=", async () => {
    setUrl("/todos?profile=finance&stage=open");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    render(
      <ProfileScope current="default">
        <Rows initial={["default's to-do"]} />
      </ProfileScope>,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Switching to finance/);
    expect(screen.queryByText("default's to-do")).toBeNull();
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/session/profile");
    expect(JSON.parse(String(init?.body))).toEqual({ profile: "finance" });
    expect(nav.replace).toHaveBeenCalledWith("/todos?stage=open");
  });

  it("explains a refused switch (not enrolled / suspended) and shows no profile's data", async () => {
    setUrl("/inbox?profile=outreach");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "You aren't enrolled in outreach." }), { status: 403 }),
    );
    render(
      <ProfileScope current="default">
        <Rows initial={["default's item"]} />
      </ProfileScope>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't open outreach: You aren't enrolled in outreach\./);
    expect(screen.getByRole("link", { name: "Stay in default" }).getAttribute("href")).toBe("/inbox");
    expect(screen.queryByText("default's item")).toBeNull();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("renders the page as-is when the link names the session's own profile", () => {
    setUrl("/todos?profile=finance");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(
      <ProfileScope current="finance">
        <Rows initial={["finance's to-do"]} />
      </ProfileScope>,
    );
    expect(screen.getByText("finance's to-do")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remounts the content on a profile switch so the old profile's rows don't stay on screen", () => {
    setUrl("/todos");
    const { rerender } = render(
      <ProfileScope current="finance">
        <Rows initial={["finance's to-do"]} />
      </ProfileScope>,
    );
    expect(screen.getByText("finance's to-do")).toBeTruthy();
    rerender(
      <ProfileScope current="outreach">
        <Rows initial={["outreach's to-do"]} />
      </ProfileScope>,
    );
    expect(screen.queryByText("finance's to-do")).toBeNull();
    expect(screen.getByText("outreach's to-do")).toBeTruthy();
  });
});
