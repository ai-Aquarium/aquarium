// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { CredentialForm, SubmitLabel } from "./CredentialForm";

afterEach(cleanup);

function Probe() {
  return (
    <CredentialForm data-component="Probe" onSubmit={(e) => e.preventDefault()}>
      <input type="text" name="username" defaultValue="alice" />
      <input type="password" name="password" defaultValue="hunter2-secret" />
      <button type="submit">
        <SubmitLabel>Sign in</SubmitLabel>
      </button>
    </CredentialForm>
  );
}

/** The URL a browser's own (no-JS) submit of `form` would load. */
function nativeSubmitUrl(form: HTMLFormElement, base: string): string {
  const action = new URL(form.getAttribute("action") ?? "", base);
  if ((form.getAttribute("method") ?? "get").toLowerCase() !== "get") return action.href;
  const query = new URLSearchParams();
  new FormData(form).forEach((v, k) => query.append(k, String(v)));
  action.search = query.toString();
  return action.href;
}

describe("CredentialForm", () => {
  it("server HTML is a POST to its own path, disabled, with a Loading… submit", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToString(<Probe />);
    const form = host.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("?");
    expect(form.dataset.hydrated).toBe("false");
    expect(form.querySelector("fieldset")!.disabled).toBe(true);
    const button = form.querySelector("button")!;
    expect(button.matches(":disabled")).toBe(true);
    expect(button.textContent).toBe("Loading…");
  });

  it("a native submit never puts the values (or the current query) in the URL", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToString(<Probe />);
    const url = nativeSubmitUrl(host.querySelector("form")!, "https://aquarium.example/login?password=old&profile=hr");
    expect(url).toMatch(/^https:\/\/aquarium\.example\/login\??$/);
    expect(url).not.toMatch(/hunter2|password|username|alice/);
  });

  it("enables the controls and shows the real label once hydrated", async () => {
    const host = document.createElement("div");
    host.innerHTML = renderToString(<Probe />);
    document.body.appendChild(host);
    expect(host.querySelector("button")!.matches(":disabled")).toBe(true);
    await act(async () => {
      hydrateRoot(host, <Probe />);
    });
    const form = host.querySelector("form")!;
    expect(form.dataset.hydrated).toBe("true");
    expect(form.querySelector("fieldset")!.disabled).toBe(false);
    expect(form.querySelector("button")!.matches(":disabled")).toBe(false);
    expect(form.querySelector("button")!.textContent).toBe("Sign in");
    expect(form.getAttribute("method")).toBe("post");
    host.remove();
  });

  it("is usable straight away when mounted after hydration (sheets, modals)", () => {
    render(<Probe />);
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).matches(":disabled")).toBe(false);
  });
});
