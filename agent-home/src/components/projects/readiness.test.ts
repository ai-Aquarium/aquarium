import { describe, expect, it } from "vitest";

import { playbook, project } from "@/components/projects/dashboard/__fixtures__/dashboard";
import { isRunnable, readinessItems } from "@/components/projects/readiness";

describe("readinessItems", () => {
  it("lets a repeatable project with no schedule start by hand", () => {
    const items = readinessItems(project({ cadence: "repeatable", schedule: null }), playbook());
    expect(isRunnable(items)).toBe(true);
  });
});
