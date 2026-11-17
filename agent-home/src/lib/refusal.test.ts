import { describe, expect, it } from "vitest";

import { withoutInternalIds } from "@/lib/refusal";

const UUID = "3f2c1a9e-8b7d-4c6e-9f10-2a3b4c5d6e7f";

describe("withoutInternalIds", () => {
  it("drops a quoted subject id from an older Hermes refusal", () => {
    const text = withoutInternalIds(`subject '${UUID}' is not enrolled in profile 'maintenance'`);
    expect(text).not.toContain(UUID);
    expect(text).not.toMatch(/subject/i);
    expect(text).toBe("Is not enrolled in profile 'maintenance'");
  });

  it("drops a bare UUID anywhere, case-insensitively", () => {
    expect(withoutInternalIds(`User ${UUID.toUpperCase()} is suspended in cfo`)).toBe("User is suspended in cfo");
  });

  it("leaves a plain refusal alone", () => {
    const plain = "You're not a member of maintenance. Ask its owner to add you.";
    expect(withoutInternalIds(plain)).toBe(plain);
  });
});
