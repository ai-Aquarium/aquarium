import { describe, expect, it } from "vitest";

import { auditSource } from "@/lib/app-mcp/hint-audit";

describe("auditSource", () => {
  it("flags an unhinted button with a one-word or dynamic name", () => {
    const gaps = auditSource(`
      export const A = () => (
        <div>
          <button type="button" onClick={() => go()}>Snooze</button>
          <ActionButton onAction={x}>{t("dismiss")}</ActionButton>
        </div>
      );
    `);
    expect(gaps.map((g) => [g.tag, g.line])).toEqual([
      ["button", 4],
      ["ActionButton", 5],
    ]);
  });

  it("accepts data-appmcp-hint, title, or a name of two words or more", () => {
    expect(
      auditSource(`
        <>
          <button data-appmcp-hint={HINTS.snooze} onClick={() => a > b}>Snooze</button>
          <button title={label}>›</button>
          <button aria-label="Close panel">×</button>
          <input placeholder="Search everything" />
          <button type="button">Work on this</button>
          <Link href="/todos">Open all tasks</Link>
        </>
      `),
    ).toEqual([]);
  });

  it("counts role-based controls and skips non-interactive markup", () => {
    const gaps = auditSource(`
      <>
        <div role="menuitem" onClick={x}>{label}</div>
        <div className="row"><span>Snooze</span></div>
        <a name="anchor">x</a>
        <input type="hidden" name="csrf" />
        <p>a<b</p>
      </>
    `);
    expect(gaps.map((g) => g.tag)).toEqual(["div"]);
  });
});
