import { describe, expect, it } from "vitest";

import { stripUiContextLine } from "@/lib/chat/transcript";
import { withUiContext } from "@/lib/chat/ui-context";

import { chatContextLine } from "./data-source";

describe("chatContextLine", () => {
  it("passes the UI line through when nothing is picked", () => {
    expect(chatContextLine("[app context: page /chat · last active: none]", "/chat", null)).toBe("[app context: page /chat · last active: none]");
  });

  it("names the picked source in a line the transcript still strips", () => {
    const line = chatContextLine(null, "/chat", { id: "1f0c2a4e-5d6b-4c7a-8e9f-0a1b2c3d4e5f", name: `ERP "prod"] ${"x".repeat(80)}` });
    expect(line).toContain('ask about data source "ERP prod');
    expect(line).toContain("source id 1f0c2a4e-5d6b-4c7a-8e9f-0a1b2c3d4e5f");
    const sent = withUiContext("How many orders?", line);
    expect(stripUiContextLine(sent)).toBe("How many orders?");
  });
});
