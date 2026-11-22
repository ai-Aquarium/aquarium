// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrandingProvider } from "@/components/brand/BrandingProvider";
import type { Branding } from "@/lib/branding/branding";

import { BoxIdentitySection } from "./BoxIdentitySection";

const fetchMock = vi.fn();

function renderWith(initial: Branding) {
  return render(
    <BrandingProvider initial={initial}>
      <BoxIdentitySection />
    </BrandingProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(cleanup);

describe("BoxIdentitySection", () => {
  it("shows the monogram default with Reset disabled when no logo is set", () => {
    const { container } = renderWith({ name: "Leo Lau", logo: null });
    expect(container.querySelector('[data-logo-state="default"]')).toBeTruthy();
    expect((container.querySelector('[data-action="reset-logo"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-component="monogram-fallback"]')?.textContent).toContain("LL");
  });

  it("saves the name and updates the previews", async () => {
    fetchMock.mockResolvedValue(Response.json({ name: "HangSengDev", logo: null }));
    const { container } = renderWith({ name: null, logo: null });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "HangSengDev" } });
    expect(container.querySelector('[data-component="monogram-fallback"]')?.textContent).toContain("“H”");
    fireEvent.click(container.querySelector('[data-action="save-name"]')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings/branding");
    expect(JSON.parse(init.body)).toEqual({ name: "HangSengDev" });
  });

  it("uploads a logo and resets it to the default", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ name: "HangSengDev", logo: { content_type: "image/png", version: "v1" } }),
    );
    const { container } = renderWith({ name: "HangSengDev", logo: null });
    const file = new File([new Uint8Array([0x89, 0x50])], "logo.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("logo-file"), { target: { files: [file] } });
    await waitFor(() => expect(container.querySelector('[data-logo-state="custom"]')).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings/branding/logo");
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);

    fetchMock.mockResolvedValueOnce(Response.json({ name: "HangSengDev", logo: null }));
    fireEvent.click(container.querySelector('[data-action="reset-logo"]')!);
    await waitFor(() => expect(container.querySelector('[data-logo-state="default"]')).toBeTruthy());
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
  });

  it("refuses an SVG before uploading", () => {
    renderWith({ name: "HangSengDev", logo: null });
    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    fireEvent.change(screen.getByTestId("logo-file"), { target: { files: [svg] } });
    expect(screen.getByRole("alert").textContent).toContain("PNG");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
