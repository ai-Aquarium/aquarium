import { describe, expect, it } from "vitest";

import {
  DOCK_DEFAULT,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  dockReducer,
  dockShortcut,
  dockStorageKey,
  parseDockState,
  serializeDockState,
} from "./dockState";

const key = (over: Partial<Parameters<typeof dockShortcut>[0]>) => ({
  key: ".",
  code: "Period",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("dock state", () => {
  it("round-trips a saved state and clamps the width", () => {
    expect(parseDockState(serializeDockState({ mode: "min", width: 500 }))).toEqual({ mode: "min", width: 500 });
    expect(parseDockState(JSON.stringify({ mode: "max", width: 9999 })).width).toBe(DOCK_MAX_WIDTH);
    expect(parseDockState(JSON.stringify({ mode: "open", width: 10 })).width).toBe(DOCK_MIN_WIDTH);
  });

  it("falls back to the default for anything unreadable", () => {
    expect(parseDockState("not json")).toEqual(DOCK_DEFAULT);
    expect(parseDockState(JSON.stringify({ mode: "huge" }))).toEqual(DOCK_DEFAULT);
  });

  it("keeps one saved layout per person", () => {
    expect(dockStorageKey("u1")).not.toBe(dockStorageKey("u2"));
  });

  it("maximize, minimize and restore move between the three modes", () => {
    const open = DOCK_DEFAULT;
    const max = dockReducer(open, { type: "maximize" });
    expect(max.mode).toBe("max");
    expect(dockReducer(max, { type: "restore" }).mode).toBe("open");
    expect(dockReducer(max, { type: "minimize" }).mode).toBe("min");
    expect(dockReducer(open, { type: "toggleMinimize" }).mode).toBe("min");
    expect(dockReducer({ ...open, mode: "min" }, { type: "toggleMinimize" }).mode).toBe("open");
    expect(dockReducer(open, { type: "toggleMaximize" }).mode).toBe("max");
    expect(dockReducer(max, { type: "toggleMaximize" }).mode).toBe("open");
  });

  it("Esc restores only from maximized", () => {
    expect(dockReducer({ ...DOCK_DEFAULT, mode: "max" }, { type: "escape" }).mode).toBe("open");
    expect(dockReducer({ ...DOCK_DEFAULT, mode: "min" }, { type: "escape" }).mode).toBe("min");
  });

  it("resizing keeps the mode and clamps the width", () => {
    const next = dockReducer(DOCK_DEFAULT, { type: "resize", width: 2000 });
    expect(next).toEqual({ mode: "open", width: DOCK_MAX_WIDTH });
  });

  it("maps the keyboard shortcuts", () => {
    expect(dockShortcut(key({ ctrlKey: true }))).toEqual({ type: "toggleMinimize" });
    expect(dockShortcut(key({ metaKey: true }))).toEqual({ type: "toggleMinimize" });
    expect(dockShortcut(key({ ctrlKey: true, shiftKey: true, key: ">" }))).toEqual({ type: "toggleMaximize" });
    expect(dockShortcut(key({ key: "Escape", code: "Escape" }))).toEqual({ type: "escape" });
    expect(dockShortcut(key({}))).toBeNull();
  });
});
