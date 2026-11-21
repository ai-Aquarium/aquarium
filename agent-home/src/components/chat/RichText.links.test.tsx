// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RichText } from "@/components/chat/RichText";

function relOf(html: string, href: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector(`a[href="${href}"]`)?.getAttribute("rel") ?? null;
}

describe("RichText links", () => {
  it("keeps the Referer on same-origin file links so the /api guard admits them", () => {
    const abs = `${window.location.origin}/api/files/abc/content`;
    const html = renderToStaticMarkup(
      <RichText content={`[chart](/api/files/abc/content) and [abs](${abs})`} />,
    );
    expect(relOf(html, "/api/files/abc/content")).toBe("noopener");
    expect(relOf(html, abs)).toBe("noopener");
  });

  it("still strips the Referer on links to other sites", () => {
    const html = renderToStaticMarkup(
      <RichText content="[docs](https://example.com/x) [proto](//evil.example/x)" />,
    );
    expect(relOf(html, "https://example.com/x")).toBe("noopener noreferrer");
    expect(relOf(html, "//evil.example/x")).toBe("noopener noreferrer");
  });
});
