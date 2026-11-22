// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BoxLogo } from "./BoxLogo";
import { BrandingProvider } from "./BrandingProvider";

const HSD = { name: "HangSengDev", logo: { content_type: "image/jpeg", version: "v1" } };

describe("BoxLogo", () => {
  afterEach(cleanup);

  it("shows the Aquarium mark when the box has no branding", () => {
    const { container } = render(<BoxLogo size={24} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/brand/aquarium-favicon.svg");
  });

  it("shows the monogram from the entity name when there is no logo", () => {
    const { container } = render(
      <BrandingProvider initial={{ name: "Leo Lau", logo: null }}>
        <BoxLogo size={28} />
      </BrandingProvider>,
    );
    const mono = container.querySelector('[data-box-logo="monogram"]');
    expect(mono?.textContent).toBe("LL");
  });

  it("shows the uploaded logo, and the monogram if it fails to load", () => {
    const { container } = render(
      <BrandingProvider initial={HSD}>
        <BoxLogo size={24} />
      </BrandingProvider>,
    );
    const img = container.querySelector('[data-box-logo="image"]');
    expect(img?.getAttribute("src")).toBe("/api/branding/logo?v=v1");
    fireEvent.error(img!);
    expect(container.querySelector('[data-box-logo="monogram"]')?.textContent).toBe("HS");
  });

  it("draws a preview branding instead of the live one", () => {
    const { container } = render(
      <BrandingProvider initial={HSD}>
        <BoxLogo branding={{ name: "Leo Lau", logo: null }} />
      </BrandingProvider>,
    );
    expect(container.querySelector('[data-box-logo="monogram"]')?.textContent).toBe("LL");
  });
});
