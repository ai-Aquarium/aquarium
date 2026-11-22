/**
 * The project chat dock's layout state: open (a column on the right),
 * maximized (the chat fills the project area) or minimized (a slim rail).
 * Saved per person in this browser together with the column width.
 */
export const DOCK_MODES = ["open", "max", "min"] as const;

export type DockMode = (typeof DOCK_MODES)[number];

export interface DockState {
  mode: DockMode;
  width: number;
}

export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 640;
export const DOCK_DEFAULT: DockState = { mode: "open", width: 400 };

export function clampDockWidth(width: number): number {
  if (!Number.isFinite(width)) return DOCK_DEFAULT.width;
  return Math.round(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, width)));
}

export function isDockMode(value: unknown): value is DockMode {
  return typeof value === "string" && (DOCK_MODES as readonly string[]).includes(value);
}

/** Read a saved state; anything unreadable falls back to the default. */
export function parseDockState(raw: string): DockState {
  try {
    const value = JSON.parse(raw) as Partial<DockState> | null;
    return {
      mode: isDockMode(value?.mode) ? value.mode : DOCK_DEFAULT.mode,
      width: clampDockWidth(typeof value?.width === "number" ? value.width : DOCK_DEFAULT.width),
    };
  } catch {
    return DOCK_DEFAULT;
  }
}

export function serializeDockState(state: DockState): string {
  return JSON.stringify({ mode: state.mode, width: clampDockWidth(state.width) });
}

/** The browser key: one saved layout per signed-in person. */
export function dockStorageKey(userId: string): string {
  return `aquarium.projects.chatDock.${userId}`;
}

export type DockAction =
  | { type: "maximize" }
  | { type: "minimize" }
  | { type: "restore" }
  | { type: "toggleMaximize" }
  | { type: "toggleMinimize" }
  | { type: "escape" }
  | { type: "resize"; width: number };

export function dockReducer(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case "maximize":
      return { ...state, mode: "max" };
    case "minimize":
      return { ...state, mode: "min" };
    case "restore":
      return { ...state, mode: "open" };
    case "toggleMaximize":
      return { ...state, mode: state.mode === "max" ? "open" : "max" };
    case "toggleMinimize":
      return { ...state, mode: state.mode === "min" ? "open" : "min" };
    case "escape":
      return state.mode === "max" ? { ...state, mode: "open" } : state;
    case "resize":
      return { ...state, width: clampDockWidth(action.width) };
  }
}

/**
 * The dock's keyboard shortcut for a keydown, if any: Ctrl/⌘+. toggles
 * minimize, Ctrl/⌘+Shift+. toggles maximize, Esc restores from maximized.
 */
export function dockShortcut(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): DockAction | null {
  const period = e.code === "Period" || e.key === "." || e.key === ">";
  if ((e.ctrlKey || e.metaKey) && period) {
    return e.shiftKey ? { type: "toggleMaximize" } : { type: "toggleMinimize" };
  }
  if (e.key === "Escape") return { type: "escape" };
  return null;
}
