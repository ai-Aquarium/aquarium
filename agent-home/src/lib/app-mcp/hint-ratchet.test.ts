/**
 * Ratchet for the `data-appmcp-hint` convention (plans/2026-11-25-app-mcp-semantic-layer.md,
 * Layer 2). Every interactive element in a component must tell the agent what
 * it does — an authored `data-appmcp-hint`, a `title`, or a name of two words
 * or more. Existing gaps are counted per file in `hint-ratchet.baseline.json`:
 * a file may never gain gaps, and when it loses some the baseline must come
 * down with it, so the count only ratchets towards zero.
 *
 * Regenerate after closing gaps: `APPMCP_HINT_BASELINE_WRITE=1 npx vitest run hint-ratchet`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditSource, type HintGap } from "@/lib/app-mcp/hint-audit";

const ROOT = path.resolve(__dirname, "../../..");
const SCANNED = ["src/components", "src/app"];
const BASELINE_FILE = path.join(__dirname, "hint-ratchet.baseline.json");

function sources(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(rel);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [rel] : [];
  });
}

function currentGaps(): Map<string, HintGap[]> {
  const out = new Map<string, HintGap[]>();
  for (const file of SCANNED.flatMap(sources).sort()) {
    const gaps = auditSource(readFileSync(path.join(ROOT, file), "utf8"));
    if (gaps.length) out.set(file, gaps);
  }
  return out;
}

describe("data-appmcp-hint ratchet", () => {
  const gaps = currentGaps();

  if (process.env.APPMCP_HINT_BASELINE_WRITE === "1") {
    const counts = Object.fromEntries([...gaps].map(([file, list]) => [file, list.length]));
    writeFileSync(BASELINE_FILE, `${JSON.stringify(counts, null, 2)}\n`);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Record<string, number>;

  it("adds no unhinted interactive elements", () => {
    const grown = [...gaps]
      .filter(([file, list]) => list.length > (baseline[file] ?? 0))
      .map(([file, list]) => {
        const lines = list.map((g) => `    ${file}:${g.line}  ${g.snippet}`).join("\n");
        return `  ${file}: ${list.length} unhinted (allowed ${baseline[file] ?? 0})\n${lines}`;
      });
    expect(
      grown,
      "Add data-appmcp-hint=\"what it does\" (English, for the agent) to the new " +
        "interactive elements, or give them a name of two words or more:\n" +
        grown.join("\n"),
    ).toEqual([]);
  });

  it("lowers the baseline when gaps close", () => {
    const stale = Object.entries(baseline)
      .filter(([file, allowed]) => (gaps.get(file)?.length ?? 0) < allowed)
      .map(([file, allowed]) => `  ${file}: ${allowed} → ${gaps.get(file)?.length ?? 0}`);
    expect(
      stale,
      `Gaps closed — lower ${path.basename(BASELINE_FILE)} (or rerun with APPMCP_HINT_BASELINE_WRITE=1):\n` +
        stale.join("\n"),
    ).toEqual([]);
  });

  it("keeps the suggested-task card actions fully hinted", () => {
    expect(gaps.get("src/components/suggested-tasks/SuggestedTaskCard.tsx")).toBeUndefined();
  });
});
