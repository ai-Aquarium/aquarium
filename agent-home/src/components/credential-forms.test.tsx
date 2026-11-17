// @vitest-environment jsdom
/**
 * No form with a password, secret, token or code field may be natively
 * submittable as a GET: before (or without) hydration a plain `<form>` submits
 * itself and puts every field in the URL. Each such form is a `CredentialForm`
 * (method=post to its own path, disabled with a "Loading…" submit until
 * hydrated); ESLint enforces the same per form.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { LoginForm } from "@/components/LoginForm";
import { ActivateForm } from "@/components/auth/ActivateForm";
import { SecretRequestModal } from "@/components/chat/SecretRequestModal";
import { SecretLinkForm } from "@/components/secret-link/SecretLinkForm";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const SRC = join(__dirname, "..");
const CREDENTIAL_FIELD = /type="password"|autoComplete="(?:new-password|current-password|one-time-code)"|<MaskedField\b/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith(".tsx") && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

describe("credential forms: source audit", () => {
  const files = tsxFiles(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") }));

  it("no component with a credential field renders a plain <form>", () => {
    const offenders = files
      .filter((f) => f.rel !== join("components", "ui", "CredentialForm.tsx"))
      .filter((f) => CREDENTIAL_FIELD.test(f.text) && /<form[\s>]/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no form anywhere asks for a GET submit", () => {
    expect(files.filter((f) => /<form[^>]*\bmethod=["'{]?\s*["']?get/i.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it("the audit still finds the known credential forms", () => {
    const users = files.filter((f) => /<CredentialForm[\s>]/.test(f.text)).map((f) => f.rel);
    expect(users).toEqual(
      expect.arrayContaining([
        join("components", "LoginForm.tsx"),
        join("components", "auth", "ActivateForm.tsx"),
        join("components", "auth", "ResetRequestForm.tsx"),
        join("components", "auth", "SetupOwnerForm.tsx"),
        join("components", "account", "AccountSecurity.tsx"),
        join("components", "account", "TwoFactorSetup.tsx"),
        join("components", "secret-link", "SecretLinkForm.tsx"),
        join("components", "chat", "SecretRequestModal.tsx"),
        join("components", "apps-secrets", "AppSecretsForm.tsx"),
      ]),
    );
  });
});

const SERVER_RENDERED: [string, ReactElement][] = [
  ["LoginForm", <LoginForm key="l" providers={[{ name: "basic", display_name: "Basic", supports_password: true }]} />],
  ["ActivateForm", <ActivateForm key="a" token={"T".repeat(43)} />],
  [
    "SecretLinkForm",
    <SecretLinkForm
      key="s"
      token={"Q".repeat(43)}
      info={{ ok: true, label: "GitHub token", purpose: "PR", kind: "secret", username: null, expires_at: 1_900_000_000 }}
    />,
  ],
  [
    "SecretRequestModal",
    <SecretRequestModal key="m" mode="save" initialName="API_KEY" onSubmit={vi.fn()} onDismiss={vi.fn()} />,
  ],
];

describe.each(SERVER_RENDERED)("%s before hydration", (_name, element) => {
  const html = () => {
    const host = document.createElement("div");
    host.innerHTML = renderToString(element);
    return host;
  };

  it("renders its credential form as method=post to its own path", () => {
    const forms = [...html().querySelectorAll("form")];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.getAttribute("method")).toBe("post");
      expect(form.getAttribute("action")).toBe("?");
      expect(form.method).toBe("post");
    }
  });

  it("keeps every submit disabled and labelled Loading…", () => {
    const submits = [...html().querySelectorAll<HTMLButtonElement>("form button[type=submit]")];
    expect(submits.length).toBeGreaterThan(0);
    for (const b of submits) {
      expect(b.matches(":disabled")).toBe(true);
      expect(b.textContent).toContain("Loading…");
    }
  });

  it("keeps every credential field out of reach until hydrated", () => {
    for (const input of html().querySelectorAll<HTMLInputElement>("form input")) {
      expect(input.matches(":disabled")).toBe(true);
    }
  });
});

describe("login page URL", () => {
  it("drops username/password/code from the address without filling the fields", async () => {
    window.history.replaceState({ k: 1 }, "", "/login?username=alice&password=hunter2-secret&code=123456&profile=hr");
    const log = vi.spyOn(console, "log");
    await act(async () => {
      render(<LoginForm providers={[{ name: "basic", display_name: "Basic", supports_password: true }]} profile="hr" />);
    });
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe("?profile=hr");
    expect(window.history.state).toEqual({ k: 1 });
    expect((screen.getByLabelText("Email or username") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toMatch(/hunter2|alice|123456/);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/hunter2/);
    log.mockRestore();
  });

  it("leaves a clean URL alone", async () => {
    window.history.replaceState(null, "", "/login?profile=hr");
    const spy = vi.spyOn(window.history, "replaceState");
    await act(async () => {
      render(<LoginForm providers={[{ name: "basic", display_name: "Basic", supports_password: true }]} />);
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
