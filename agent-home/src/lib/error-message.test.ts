import { describe, expect, it } from "vitest";

import { describeError } from "./error-message";

describe("describeError", () => {
  it("shows a crafted error's own message", () => {
    expect(describeError(new Error("session not found"), "oops")).toBe("session not found");
  });

  it("leads with the operation for a browser fetch failure (TypeError)", () => {
    // Safari: TypeError "Load failed"; Chrome: "Failed to fetch"; Firefox:
    // "NetworkError when attempting to fetch resource" — boilerplate that
    // needs the operation in front of it.
    for (const raw of ["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource"]) {
      expect(describeError(new TypeError(raw), "Failed to load conversation.")).toBe(
        `Failed to load conversation. (${raw})`,
      );
    }
  });

  it("falls back for non-Error throws and empty messages", () => {
    expect(describeError("nope", "oops")).toBe("oops");
    expect(describeError(null, "oops")).toBe("oops");
    expect(describeError(new Error(""), "oops")).toBe("oops");
    expect(describeError(new TypeError(""), "oops")).toBe("oops");
  });
});
