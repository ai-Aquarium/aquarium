import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FleetView } from "@/components/settings/FleetView";
import type { FleetBox, FleetStatus } from "@/types";

/**
 * SSR-based tests for FleetView. renderToStaticMarkup does not run useEffect,
 * so the switch-job poll never fires — the tests cover the initial render:
 * the box cards, the layout chips and the switch button's enabled state.
 */

const LEO: FleetBox = {
  name: "leo",
  label: "Leo's box",
  self: true,
  reachable: true,
  installed: {
    layout: "git",
    version: null,
    label: "git-a1b2c3d",
    commit: "a1b2c3d",
    channel: null,
    installed_at: null,
  },
  job: null,
  switch: null,
  error: null,
};

const HSD: FleetBox = {
  name: "hsd",
  label: "HSD",
  self: false,
  reachable: true,
  installed: {
    layout: "release",
    version: "v1.0.0",
    label: "v1.0.0",
    commit: null,
    channel: "stable",
    installed_at: "2026-11-01T10:00:00Z",
  },
  job: null,
  switch: null,
  error: null,
};

const status = (boxes: FleetBox[]): FleetStatus => ({ available: true, boxes });

describe("FleetView", () => {
  it("says the fleet is not set up when unavailable", () => {
    const html = renderToStaticMarkup(<FleetView initial={{ available: false }} />);
    expect(html).toContain('data-component="FleetView"');
    expect(html).toContain("doesn&#x27;t manage a fleet");
    expect(html).not.toContain("Switch to");
  });

  it("renders one card per box with its layout chip", () => {
    const html = renderToStaticMarkup(<FleetView initial={status([LEO, HSD])} />);
    expect(html).toContain('data-box="leo"');
    expect(html).toContain('data-box="hsd"');
    expect(html).toContain("Leo&#x27;s box");
    expect(html).toContain("this box");
    expect(html).toContain("Direct deploy");
    expect(html).toContain("Software upgrade");
    expect(html).toContain("v1.0.0");
  });

  it("offers the opposite layout on each reachable box", () => {
    const html = renderToStaticMarkup(<FleetView initial={status([LEO, HSD])} />);
    expect(html).toContain("Switch to software upgrade"); // Leo's box is on git
    expect(html).toContain("Switch to direct deploy"); // HSD is on release
    expect(html).toContain("data-appmcp-hint");
  });

  it("marks an unreachable box and disables its switch", () => {
    const down: FleetBox = {
      ...HSD,
      name: "down",
      label: "Old box",
      reachable: false,
      installed: null,
      error: "ssh: connect failed",
    };
    const html = renderToStaticMarkup(<FleetView initial={status([LEO, down])} />);
    expect(html).toContain("unreachable");
    expect(html).toContain("ssh: connect failed");
    const boxHtml = html.slice(html.indexOf('data-box="down"'));
    expect(boxHtml.slice(0, boxHtml.indexOf("</section>"))).not.toContain(
      "Switch to",
    );
  });

  it("shows a running switch with its log instead of the button", () => {
    const busy: FleetBox = {
      ...HSD,
      switch: {
        id: "s1",
        to: "git",
        by: "Leo",
        started: "2026-11-27T12:00:00Z",
        finished: null,
        state: "running",
        active: "active",
        log: ["==> building agent-home"],
      },
    };
    const html = renderToStaticMarkup(<FleetView initial={status([busy])} />);
    expect(html).toContain('data-component="FleetSwitchProgress"');
    expect(html).toContain("Switching to Direct deploy");
    expect(html).toContain("building agent-home");
    expect(html).toContain("disabled");
  });
});
