// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SoftwareUpgradeView, tookLabel } from "@/components/settings/SoftwareUpgradeView";
import type { SoftwareUpgradeJob, SoftwareUpgradePreflight, SoftwareUpgradeStatus } from "@/types";

const PASS = (version: string, busy: string[] = []): SoftwareUpgradePreflight => ({
  version,
  ok: true,
  busy,
  checks: (["disk", "backup", "services", "release"] as const).map((key) => ({ key, ok: true, message: `${key} fine` })),
});

/** fetch by path; `/check` answers with the pre-flight for the version it is sent. */
function serve(answers: Record<string, (init?: RequestInit) => unknown>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const answer = answers[url];
    if (answer) return new Response(JSON.stringify(answer(init)), { status: 202 });
    if (url === "/api/software-upgrade/check") {
      const version = JSON.parse(String(init?.body ?? "{}")).version as string;
      return new Response(JSON.stringify({ preflight: PASS(version) }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  serve({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rel = (tag: string, published_at: string) => ({
  tag,
  name: tag,
  published_at,
  prerelease: false,
  url: `https://github.com/leolau/aquarium/releases/tag/${tag}`,
  highlights: [{ title: "Fixes", items: [`fix in ${tag}`] }],
});

const STATUS: SoftwareUpgradeStatus = {
  available: true,
  installed: {
    version: "v1.1.0",
    label: "v1.1.0",
    commit: null,
    kind: "release",
    channel: "stable",
    installed_at: "2026-11-01T09:00:00Z",
    by: "leo",
  },
  job: null,
  history: [],
  checked_at: "2026-11-05T08:00:00Z",
  rollback_to: null,
  releases: {
    newer: [rel("v1.3.0", "2026-11-04T00:00:00Z"), rel("v1.2.0", "2026-11-02T00:00:00Z")],
    older: [rel("v1.0.0", "2026-10-01T00:00:00Z")],
    latest: "v1.3.0",
  },
  can_upgrade: true,
};

const step = (key: string, state: string) => ({ key, state, started: null, finished: null });
const JOB: SoftwareUpgradeJob = {
  id: "j1",
  kind: "upgrade",
  from: "v1.1.0",
  to: "v1.3.0",
  by: "leo",
  started: "2026-11-05T09:00:00Z",
  finished: null,
  running: true,
  result: null,
  error: null,
  steps: [step("backup", "done"), step("download", "running"), step("checks", "pending")] as SoftwareUpgradeJob["steps"],
  log: ["== backup =="],
};

describe("SoftwareUpgradeView", () => {
  it("selects the latest release and labels the button with it", () => {
    render(<SoftwareUpgradeView initial={STATUS} />);
    expect(screen.getByTestId("upgrade-button").textContent).toBe("Upgrade to v1.3.0");
    expect(screen.getByTestId("upgrade-banner").textContent).toContain("2 newer releases");
    expect(screen.getByText("fix in v1.3.0")).toBeTruthy();
  });

  it("lets the owner pick another release, and older ones become a roll back", () => {
    render(<SoftwareUpgradeView initial={STATUS} />);
    fireEvent.click(screen.getByText("v1.2.0"));
    expect(screen.getByTestId("upgrade-button").textContent).toBe("Upgrade to v1.2.0");
    expect(screen.queryByTestId("upgrade-older")).toBeNull();
    fireEvent.click(screen.getByTestId("upgrade-show-older"));
    fireEvent.click(screen.getByText("v1.0.0"));
    expect(screen.getByTestId("upgrade-button").textContent).toBe("Roll back to v1.0.0");
  });

  it("asks for the password and sends only the chosen version", async () => {
    const fetchMock = serve({ "/api/software-upgrade/start": () => ({ started: true, status: { ...STATUS, job: JOB } }) });
    render(<SoftwareUpgradeView initial={STATUS} />);
    await waitFor(() => expect((screen.getByTestId("upgrade-button") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("upgrade-button"));
    expect(screen.getByText("Upgrade to v1.3.0?")).toBeTruthy();
    expect((screen.getByTestId("upgrade-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("upgrade-confirm"));
    await waitFor(() => expect(screen.getByText("Upgrading v1.1.0 → v1.3.0")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls.find((c) => c[0] === "/api/software-upgrade/start") as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/software-upgrade/start");
    expect(JSON.parse(String(init.body))).toEqual({ version: "v1.3.0", password: "pw" });
  });

  it("keeps Upgrade off while a pre-flight check fails and says why", async () => {
    const failing: SoftwareUpgradePreflight = {
      ...PASS("v1.3.0"),
      ok: false,
      checks: PASS("v1.3.0").checks.map((c) =>
        c.key === "disk" ? { ...c, ok: false, message: "Only 2 GB of disk space is free; at least 5 GB is needed." } : c,
      ),
    };
    serve({ "/api/software-upgrade/check": () => ({ preflight: failing }) });
    render(<SoftwareUpgradeView initial={STATUS} />);
    await waitFor(() => expect(screen.getByText(/Only 2 GB of disk space/)).toBeTruthy());
    expect((screen.getByTestId("upgrade-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("upgrade-preflight-failed")).toBeTruthy();
    expect(screen.getByTestId("upgrade-preflight").querySelector('[data-check="disk"]')?.getAttribute("data-ok")).toBe("0");
  });

  it("shows each check as it finishes while the answer is still in flight", async () => {
    let finishCheck: ((r: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/software-upgrade/job")
        return new Response(JSON.stringify({
          check: {
            version: "v1.3.0", started: "2026-11-05T08:00:00", done: false,
            checks: [
              { key: "disk", running: false, ok: true, message: "40 GB of disk space is free." },
              { key: "backup", running: false, ok: true, message: "The backup folder can be written to." },
              { key: "services", running: true, ok: false, message: "Asking every service if it is healthy." },
            ],
          },
        }), { status: 200 });
      if (url === "/api/software-upgrade/check")
        return new Promise<Response>((resolve) => { finishCheck = resolve; });
      return new Response("{}", { status: 404 });
    }));
    render(<SoftwareUpgradeView initial={STATUS} />);
    const list = await waitFor(() => screen.getByTestId("upgrade-preflight"));
    await waitFor(() => {
      expect(list.querySelector('[data-check="disk"]')?.getAttribute("data-ok")).toBe("1");
      expect(list.querySelector('[data-check="disk"]')?.textContent).toContain("40 GB of disk space");
      expect(list.querySelector('[data-check="services"]')?.getAttribute("data-ok")).toBe("");
      expect(list.querySelector('[data-check="services"]')?.textContent).toContain("Asking every service");
      expect(list.querySelector('[data-check="release"]')?.getAttribute("data-ok")).toBe("");
    });
    await act(async () => {
      finishCheck?.(new Response(JSON.stringify({ preflight: PASS("v1.3.0") }), { status: 200 }));
    });
    await waitFor(() =>
      expect(list.querySelector('[data-check="release"]')?.getAttribute("data-ok")).toBe("1"));
  });

  it("says the check itself failed instead of leaving every row pending", async () => {
    serve({
      "/api/software-upgrade/check": () => ({
        preflight: { version: "v1.3.0", ok: false, checks: [], busy: [],
                     error: "The server took too long to answer. Try again." },
      }),
    });
    render(<SoftwareUpgradeView initial={STATUS} />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("took too long to answer"));
  });

  it("warns about work in progress and needs a tick to upgrade anyway", async () => {
    const fetchMock = serve({
      "/api/software-upgrade/check": () => ({ preflight: PASS("v1.3.0", ["1 project run is in progress"]) }),
      "/api/software-upgrade/start": () => ({ started: true, status: { ...STATUS, job: JOB } }),
    });
    render(<SoftwareUpgradeView initial={STATUS} />);
    await waitFor(() => expect(screen.getByTestId("upgrade-preflight-busy").textContent).toContain("1 project run"));
    fireEvent.click(screen.getByTestId("upgrade-button"));
    expect(screen.getByTestId("upgrade-busy").textContent).toContain("1 project run is in progress");
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "pw" } });
    expect((screen.getByTestId("upgrade-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("upgrade-busy-confirm"));
    fireEvent.click(screen.getByTestId("upgrade-confirm"));
    await waitFor(() => expect(screen.getByText("Upgrading v1.1.0 → v1.3.0")).toBeTruthy());
    const start = fetchMock.mock.calls.find((c) => c[0] === "/api/software-upgrade/start") as unknown as [string, RequestInit];
    expect(JSON.parse(String(start[1].body))).toEqual({ version: "v1.3.0", password: "pw", confirm_busy: true });
  });

  it("shows a failed finish with its reason and a Try again", async () => {
    const fetchMock = serve({
      "/api/software-upgrade/finish": () => ({
        started: true,
        status: { ...STATUS, finish: null, job: { ...JOB, kind: "finish", from: "v1.1.0", to: "v1.1.0" } },
      }),
    });
    render(
      <SoftwareUpgradeView
        initial={{ ...STATUS, finish: { failed: true, error: "sudoers rule hermes-tools did not pass visudo", at: null } }}
      />,
    );
    const banner = screen.getByTestId("upgrade-finish-failed");
    expect(banner.textContent).toContain("Finishing the upgrade to v1.1.0 failed.");
    expect(banner.textContent).toContain("did not pass visudo");
    fireEvent.click(screen.getByTestId("upgrade-finish-retry"));
    await waitFor(() => expect(screen.getByText("Finishing the upgrade to v1.1.0: updating system helpers")).toBeTruthy());
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/software-upgrade/finish")).toBe(true);
  });

  it("is read only without can_upgrade", () => {
    render(<SoftwareUpgradeView initial={{ ...STATUS, can_upgrade: false }} />);
    expect(screen.getByTestId("upgrade-read-only")).toBeTruthy();
    expect(screen.queryByTestId("upgrade-button")).toBeNull();
  });

  it("shows the running job's steps", () => {
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: JOB }} />);
    expect(document.querySelector('[data-step="download"]')?.getAttribute("data-state")).toBe("running");
    expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
  });

  it("says the backup only saved changes when the job used a base backup", () => {
    const since = "2026-11-05T03:30:00Z";
    const { unmount } = render(
      <SoftwareUpgradeView initial={{ ...STATUS, job: { ...JOB, backup_since: since } }} />,
    );
    const row = document.querySelector('[data-step="backup"]')?.textContent ?? "";
    expect(row).toContain("Backing up changes since");
    expect(row).not.toContain("Back up");
    unmount();
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: JOB }} />);
    expect(document.querySelector('[data-step="backup"]')?.textContent).toContain("Back up");
    expect(document.querySelector('[data-step="backup"]')?.textContent).not.toContain("changes since");
  });

  const PREPARING = "A background backup is preparing the next upgrade.";
  const FINISHED = "The background backup finished, so the next upgrade only backs up what changed.";
  const FAILED = "The background backup did not finish, so the next upgrade takes a full backup.";

  async function finishWatchedJob(answer: () => Partial<SoftwareUpgradeStatus>, jobExtra: Partial<SoftwareUpgradeJob>) {
    vi.useFakeTimers();
    const done: SoftwareUpgradeJob = {
      ...JOB,
      running: false,
      result: "ok",
      finished: "2026-11-05T09:10:00Z",
      steps: JOB.steps.map((s) => ({ ...s, state: "done" })),
      ...jobExtra,
    };
    const fetchMock = serve({ "/api/software-upgrade/job": () => ({ ...STATUS, job: done, ...answer() }) });
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: JOB }} />);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByTestId("upgrade-done-banner")).toBeTruthy();
    return fetchMock;
  }

  it.each([
    [null, PREPARING],
    [{ state: "running", after_job: "j1" }, PREPARING],
    [{ state: "done", after_job: "j0" }, PREPARING],
    [{ state: "done", after_job: "j1" }, FINISHED],
    [{ state: "failed", after_job: "j1" }, FAILED],
  ] as const)("notes the background backup after a successful upgrade (%o)", async (base, text) => {
    try {
      await finishWatchedJob(() => ({ base_job: base ? { ...base, finished: null, error: null } : null }), {
        base_started: true,
      });
      expect(screen.getByTestId("upgrade-base-backup").textContent).toBe(text);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps checking the background backup until it finishes", async () => {
    let base: SoftwareUpgradeStatus["base_job"] = { state: "running", after_job: "j1", finished: null, error: null };
    try {
      const fetchMock = await finishWatchedJob(() => ({ base_job: base }), { base_started: true });
      expect(screen.getByTestId("upgrade-base-backup").textContent).toBe(PREPARING);
      base = { ...base!, state: "done", finished: "2026-11-05T09:40:00Z" };
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(screen.getByTestId("upgrade-base-backup").textContent).toBe(FINISHED);
      const polls = fetchMock.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(fetchMock.mock.calls.length).toBe(polls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no background backup note when none was started", async () => {
    try {
      await finishWatchedJob(() => ({}), {});
      expect(screen.queryByTestId("upgrade-base-backup")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("animates the running step and counts how long it has been working", () => {
    const started = new Date(Date.now() - 75_000).toISOString();
    const job = {
      ...JOB,
      steps: [step("backup", "done"), { ...step("download", "running"), started }, step("checks", "pending")],
    } as SoftwareUpgradeJob;
    render(<SoftwareUpgradeView initial={{ ...STATUS, job }} />);
    const row = document.querySelector('[data-step="download"]')!;
    expect(row.getAttribute("aria-current")).toBe("step");
    expect(row.querySelector('img[src="/brand/aquarium-loader.svg"]')).not.toBeNull();
    expect(row.textContent).toMatch(/Working… 1 m 1[5-7] s so far/);
    expect(document.querySelector('[data-step="checks"] img')).toBeNull();
    expect(screen.getByTestId("upgrade-progress-current")).toBeTruthy();
  });

  it("offers rollback after a finished upgrade it watched", () => {
    const done = { ...JOB, running: false, result: "ok", finished: "2026-11-05T09:04:37Z" };
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: done, rollback_to: "v1.1.0" }} />);
    // Not watched in this tab: the release list shows, not the finished page.
    expect(screen.getByTestId("upgrade-button")).toBeTruthy();
    expect(tookLabel(277)).toBe("4 m 37 s");
  });

  it("on a branch checkout, lists the branch commits that aren't installed", () => {
    const checkout: SoftwareUpgradeStatus = {
      ...STATUS,
      installed: { ...STATUS.installed!, version: null, label: "develop@7b09787fc", commit: "7b09787fc", kind: "checkout" },
      releases: { newer: [], older: [], latest: null },
      checkout: {
        branch: "develop",
        commit: "7b09787fc",
        behind: 2,
        tip: "5188a9b00",
        commits: [
          { sha: "5188a9b00", title: "test(smoke): page markers", date: null },
          { sha: "549c6eb00", title: "feat(agent-home): steer", date: null },
        ],
        error: null,
      },
    };
    render(<SoftwareUpgradeView initial={checkout} />);
    expect(screen.getByTestId("upgrade-banner").textContent).toBe("No newer tagged release.");
    const card = screen.getByTestId("upgrade-checkout").textContent ?? "";
    expect(card).toContain("2 commits on develop aren't installed yet.");
    expect(card).toContain("5188a9b");
    expect(card).toContain("feat(agent-home): steer");
  });

  it("on an up-to-date checkout says so, and a release install shows no branch card", () => {
    const base = { ...STATUS.installed!, version: null, label: "develop@x", commit: "abc1234", kind: "checkout" as const };
    render(
      <SoftwareUpgradeView
        initial={{ ...STATUS, installed: base, checkout: { branch: "develop", commit: "abc1234", behind: 0, tip: null, commits: [], error: null } }}
      />,
    );
    expect(screen.getByTestId("upgrade-checkout").textContent).toBe("Up to date with develop.");
    cleanup();
    render(<SoftwareUpgradeView initial={STATUS} />);
    expect(screen.queryByTestId("upgrade-checkout")).toBeNull();
  });
});

describe("technical log", () => {
  it("maximizes the log without its height cap and Esc minimizes it", () => {
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: JOB }} />);
    const pre = screen.getByText("== backup ==");
    const panel = pre.closest<HTMLElement>('[data-component="UpgradeLog"]')!;
    expect(pre.className).toContain("max-h-48");
    fireEvent.click(screen.getByRole("button", { name: "Maximize Technical log" }));
    expect(screen.getByRole("dialog", { name: "Technical log" })).toBe(panel);
    expect(pre.className).not.toContain("max-h-");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel.getAttribute("data-maximized")).toBe("false");
    expect(pre.className).toContain("max-h-48");
  });

  it("is written in the foreground colour, not the background's", () => {
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: JOB }} />);
    const pre = screen.getByText("== backup ==");
    expect(pre.className).toContain("text-[var(--color-fg)]");
    expect(pre.className).not.toContain("text-[var(--color-bg)]");
  });
});

describe("finish job", () => {
  it("names its install step after the system helpers", () => {
    const finish = {
      ...JOB,
      kind: "finish",
      from: "v1.3.0",
      to: "v1.3.0",
      steps: [step("download", "done"), step("install", "running"), step("checks", "pending")],
    } as SoftwareUpgradeJob;
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: finish }} />);
    expect(screen.getByText("Install system helpers")).toBeTruthy();
    expect(screen.queryByText("Install packages")).toBeNull();
  });
});
