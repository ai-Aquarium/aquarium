import { describe, expect, it } from "vitest";

import { canReadMediaPath, slug } from "@/lib/supabase/storage";
import type { Principal } from "@/types";

// Shared with tests/hermes_cli/test_agent_home_media.py: the Python side
// (hermes_cli.file_registry) uploads the agent's files under these keys, and
// this read route must accept every one of them for its owner.
import vectors from "./slug-vectors.json";

function owner(user_id: string): Principal {
  return { user_id, display: user_id, role: "member", channels: [], is_owner: false };
}

describe("slug parity with the Python file registry", () => {
  it.each(vectors.slug)("slug($input) matches Python", ({ input, slug: expected }) => {
    expect(slug(input)).toBe(expected);
  });

  it.each(vectors.keys)("$filename is readable by its owner", ({ user_id, key }) => {
    expect(canReadMediaPath(owner(user_id), key)).toBe(true);
    expect(canReadMediaPath(owner(`${user_id}x`), key)).toBe(false);
  });
});
