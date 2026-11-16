// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { lockBodyScroll } from "./body-scroll-lock";

afterEach(() => {
  document.body.style.overflow = "";
});

describe("lockBodyScroll", () => {
  it("restores the body's own overflow only when the last lock is released, in any order", () => {
    document.body.style.overflow = "auto";
    const outer = lockBodyScroll();
    const inner = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");
    outer();
    expect(document.body.style.overflow).toBe("hidden");
    inner();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("ignores a second release of the same lock", () => {
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    a();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
  });
});
