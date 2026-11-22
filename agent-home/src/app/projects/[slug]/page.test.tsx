// @vitest-environment jsdom
/** The project page: Back comes from the shell; every project opens the one page. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectMock = vi.hoisted(() => vi.fn());
const fanOut = vi.hoisted(() => () => Promise.reject(new Error("unused")));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {}, back: () => {} }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

vi.mock("@/lib/auth/session", () => ({ readSession: async () => ({ profile: "default" }) }));
vi.mock("@/lib/env", () => ({ storageConfigured: () => false }));

vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async () => ({ user_id: "leo", role: "owner" }),
  apiClientForRequest: async () => ({
    project: projectMock,
    projectBoard: fanOut,
    projectPlaybook: fanOut,
    projectDirectives: fanOut,
    projectDoctor: fanOut,
  }),
}));

vi.mock("@/components/MobileShell", () => ({
  // The shell's PageHeader owns Back; record what the page hands it.
  MobileShell: ({
    children,
    title,
    labels,
  }: {
    children: React.ReactNode;
    title: string;
    labels?: Record<string, string>;
  }) => (
    <div data-testid="shell" data-title={title} data-labels={JSON.stringify(labels ?? null)}>
      {children}
    </div>
  ),
}));

// The detail view has its own tests; only the page's chrome is under test.
const detailProps = vi.hoisted(() => vi.fn());
vi.mock("@/components/projects/ProjectDetailView", () => ({
  ProjectDetailView: (props: unknown) => {
    detailProps(props);
    return <div data-testid="detail" />;
  },
}));

import Page from "./page";

const PARAMS = Promise.resolve({ slug: "aws-ec2-instance-health-check" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the project page", () => {
  it("titles the shell with the project and leaves Back to the shell", async () => {
    projectMock.mockResolvedValue({ name: "AWS EC2 instance health check", cadence: "standing" });
    const { getByTestId, queryByRole } = render(await Page({ params: PARAMS }));
    expect(getByTestId("shell").getAttribute("data-title")).toBe("AWS EC2 instance health check");
    expect(queryByRole("link", { name: "← Projects" })).toBeNull();
    expect(getByTestId("detail")).toBeTruthy();
  });

  it("opens a one-off on the same project page, with the chat", async () => {
    projectMock.mockResolvedValue({ name: "Quote", cadence: "one_off" });
    const { getByTestId } = render(await Page({ params: PARAMS }));
    expect(getByTestId("detail")).toBeTruthy();
    expect(detailProps.mock.calls.at(-1)?.[0]).toMatchObject({
      chat: { profile: "default", sessionId: null, messages: [] },
    });
  });

  it.each([
    [{ view: "task" }, "/projects/aws-ec2-instance-health-check"],
    [{ view: "project", tab: "work" }, "/projects/aws-ec2-instance-health-check?tab=work"],
  ])("redirects the old %o link to the one page", async (query, to) => {
    await expect(Page({ params: PARAMS, searchParams: Promise.resolve(query) })).rejects.toThrow(
      `NEXT_REDIRECT ${to}`,
    );
    expect(projectMock).not.toHaveBeenCalled();
  });

  it("passes ?tab= through for the view to map", async () => {
    projectMock.mockResolvedValue({ name: "Quote", cadence: "one_off" });
    render(await Page({ params: PARAMS, searchParams: Promise.resolve({ tab: "board" }) }));
    expect(detailProps.mock.calls.at(-1)?.[0]).toMatchObject({ initialTab: "board" });
  });

  it("shows the friendly error when the project couldn't load", async () => {
    projectMock.mockRejectedValue(new Error("down"));
    const { container, getByText } = render(await Page({ params: PARAMS }));
    expect(container.querySelector('[data-component="ProjectPageError"] [data-component="ErrorState"]')).toBeTruthy();
    expect(getByText(/Couldn.t load this project/)).toBeTruthy();
  });
});
