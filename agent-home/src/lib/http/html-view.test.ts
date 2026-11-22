import { describe, expect, it } from "vitest";

import {
  applyHtmlViewHeaders,
  HTML_VIEW_CSP,
  isHtmlFile,
  NEW_TAB_LINKS_SCRIPT,
  withNewTabLinks,
} from "@/lib/http/file-headers";

describe("isolated HTML viewer headers", () => {
  it("recognises HTML by type, or by name only when untyped", () => {
    expect(isHtmlFile("text/html; charset=utf-8", "x.bin")).toBe(true);
    expect(isHtmlFile("application/octet-stream", "chart.HTML")).toBe(true);
    expect(isHtmlFile("", "a.htm")).toBe(true);
    expect(isHtmlFile("image/png", "trick.html")).toBe(false);
    expect(isHtmlFile("application/pdf", "a.pdf")).toBe(false);
  });

  it("gives the page an opaque origin with no network back to agent-home", () => {
    const sandbox = HTML_VIEW_CSP.split(";")[0];
    expect(sandbox).toMatch(/^sandbox /);
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-forms");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(HTML_VIEW_CSP).toContain("connect-src 'none'");
    expect(HTML_VIEW_CSP).toContain("form-action 'none'");
    expect(HTML_VIEW_CSP).toContain("frame-ancestors 'self'");
    expect(HTML_VIEW_CSP).not.toMatch(/-src[^;]*'self'/);
  });

  it("serves inline HTML under the viewer CSP", () => {
    const h = applyHtmlViewHeaders(new Headers({ "content-type": "application/octet-stream" }), "c.html");
    expect(h.get("content-type")).toBe("text/html; charset=utf-8");
    expect(h.get("content-disposition")).toMatch(/^inline;/);
    expect(h.get("content-security-policy")).toBe(HTML_VIEW_CSP);
    expect(h.get("x-content-type-options")).toBe("nosniff");
  });

  it("adds the new-tab link script once, inside the head", () => {
    const out = withNewTabLinks("<!DOCTYPE html><html><head><title>t</title></head><body></body></html>");
    expect(out.startsWith("<!DOCTYPE html><html><head>" + NEW_TAB_LINKS_SCRIPT + "<title>")).toBe(true);
    expect(out.split(NEW_TAB_LINKS_SCRIPT)).toHaveLength(2);
    expect(withNewTabLinks("<p>bare</p>")).toBe(NEW_TAB_LINKS_SCRIPT + "<p>bare</p>");
    expect(withNewTabLinks("<!doctype html><p>x</p>")).toBe("<!doctype html>" + NEW_TAB_LINKS_SCRIPT + "<p>x</p>");
  });
});
