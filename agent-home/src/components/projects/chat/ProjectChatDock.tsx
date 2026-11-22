"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  CollapseRightIcon,
  MaximizeIcon,
  MessageIcon,
  PanelLeftIcon,
  RestoreIcon,
} from "@/components/ui/icons";
import { useT } from "@/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";

import {
  DOCK_DEFAULT,
  dockReducer,
  dockShortcut,
  dockStorageKey,
  parseDockState,
  serializeDockState,
  type DockAction,
  type DockMode,
  type DockState,
} from "./dockState";

const ICON_BTN =
  "inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]";

const DESKTOP = "(min-width: 1024px)";

/** Another maximized panel or an open dialog owns Esc. */
function escBelongsElsewhere(target: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  if (target instanceof Element && target.closest('[role="dialog"]'))
    return true;
  return (
    document.querySelector(
      '[data-maximizable][data-maximized="true"], [role="dialog"][aria-modal="true"], #coral-panel[role="menu"]',
    ) !== null
  );
}

/** The dock's mode + width, saved per person, and its keyboard shortcuts. */
/** True at the desktop breakpoint, where the dock (not the Chat tab) shows chat. */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DESKTOP);
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return desktop;
}

export function useChatDock(
  userId: string,
): [DockState, (action: DockAction) => void] {
  const [saved, save] = usePersistentState(
    dockStorageKey(userId),
    DOCK_DEFAULT,
    parseDockState,
    serializeDockState,
  );
  const stateRef = useRef(saved);
  useEffect(() => {
    stateRef.current = saved;
  });
  const dispatch = useCallback(
    (action: DockAction) => save(dockReducer(stateRef.current, action)),
    [save],
  );
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!window.matchMedia?.(DESKTOP).matches) return;
      const action = dockShortcut(e);
      if (!action) return;
      if (action.type === "escape") {
        if (
          stateRef.current.mode !== "max" ||
          e.defaultPrevented ||
          escBelongsElsewhere(e.target)
        )
          return;
      }
      e.preventDefault();
      dispatch(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);
  return [saved, dispatch];
}

/**
 * The project page's chat (2026-11-22 redesign, PR 1): a column on the
 * right of Planning / Execution / Log that can be maximized over the
 * project area (a slim "Show project" strip stays on the left) or minimized
 * to a rail with the profile and an unread count. The chat itself is the
 * unchanged `ChatPane`, rendered once — switching modes only changes the
 * frame around it, so a typed draft, a streaming reply and the scroll
 * position survive (the `Maximizable` rule). Mode and width come from
 * `useChatDock` (kept per person in this browser).
 *
 * On a phone the chat is the Chat tab instead: no dock controls, and the
 * frame shows only while that tab is selected (`phoneOpen`).
 */
export function ProjectChatDock({
  state: saved,
  dispatch,
  profile,
  phoneOpen,
  children,
}: {
  state: DockState;
  dispatch: (action: DockAction) => void;
  profile: string;
  phoneOpen: boolean;
  /** The chat; it receives a message-count callback for the unread badge. */
  children: (onMessageCount: (count: number) => void) => ReactNode;
}) {
  const t = useT("projects");
  const desktop = useIsDesktop();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? saved.width;
  const mode = saved.mode;

  // Unread: messages that arrived while the dock was minimized.
  const [count, setCount] = useState(0);
  const [seen, setSeen] = useState<number | null>(null);
  const onMessageCount = useCallback((n: number) => setCount(n), []);
  if (mode !== "min" && seen !== null) setSeen(null);
  if (mode === "min" && seen === null) setSeen(count);
  const unread =
    mode === "min" && seen !== null ? Math.max(0, count - seen) : 0;

  const restoreRef = useRef<HTMLButtonElement>(null);
  const maximizeRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const previous = useRef<DockMode>(mode);
  useEffect(() => {
    if (previous.current === mode) return;
    previous.current = mode;
    if (typeof window === "undefined" || !window.matchMedia?.(DESKTOP).matches)
      return;
    if (mode === "min") railRef.current?.focus();
    else if (mode === "max") restoreRef.current?.focus();
    else maximizeRef.current?.focus();
  }, [mode]);

  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setDragWidth(
      dockReducer(saved, {
        type: "resize",
        width: drag.current.width + drag.current.x - e.clientX,
      }).width,
    );
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragWidth !== null) dispatch({ type: "resize", width: dragWidth });
    setDragWidth(null);
  };
  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    dispatch({ type: "resize", width: saved.width + step });
  };

  const initial = (profile.trim()[0] ?? "?").toUpperCase();
  const avatar = (
    <span
      aria-hidden
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-full)] bg-[var(--color-accent)] text-xs font-semibold text-[var(--color-accent-fg)]"
    >
      {initial}
    </span>
  );

  return (
    <>
      {mode === "max" ? (
        <button
          type="button"
          data-component="ShowProjectStrip"
          data-action="show-project"
          onClick={() => dispatch({ type: "restore" })}
          title={t("dock.showProjectHint")}
          className="hidden w-10 shrink-0 flex-col items-center gap-2 self-stretch rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] py-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] lg:flex"
        >
          <PanelLeftIcon />
          <span className="[writing-mode:vertical-rl]">
            {t("dock.showProject")}
          </span>
        </button>
      ) : null}
      <aside
        data-component="ProjectChatDock"
        data-mode={mode}
        aria-label={t("dock.aria")}
        style={mode === "open" && desktop ? { width } : undefined}
        className={`relative min-h-0 min-w-0 flex-col max-lg:h-[calc(100dvh-13rem)] max-lg:w-full max-lg:min-h-[420px] lg:sticky lg:top-4 lg:h-[calc(100dvh-11rem)] ${
          phoneOpen ? "flex" : "max-lg:hidden lg:flex"
        } ${mode === "max" ? "lg:flex-1" : "lg:shrink-0"} ${mode === "min" ? "lg:w-12" : ""}`}
      >
        {mode === "open" ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("dock.resize")}
            aria-valuenow={width}
            tabIndex={0}
            data-action="resize-chat"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onHandleKey}
            title={t("dock.resize")}
            className="absolute -left-3 top-0 hidden h-full w-3 cursor-col-resize touch-none items-center justify-center lg:flex"
          >
            <span className="h-10 w-1 rounded-[var(--radius-full)] bg-[var(--color-border)]" />
          </div>
        ) : null}

        {mode === "min" ? (
          <button
            ref={railRef}
            type="button"
            data-component="ProjectChatRail"
            data-action="open-chat"
            onClick={() => dispatch({ type: "restore" })}
            title={t("dock.openHint")}
            aria-label={
              unread > 0
                ? t("dock.openUnread", { count: unread })
                : t("dock.open")
            }
            className="hidden h-full w-12 flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] py-3 text-[var(--color-muted)] hover:text-[var(--color-fg)] lg:flex"
          >
            <span className="relative">
              {avatar}
              {unread > 0 ? (
                <span
                  data-component="ProjectChatUnread"
                  className="absolute -right-1.5 -top-1.5 min-w-4 rounded-[var(--radius-full)] bg-[var(--color-danger,#dc2626)] px-1 text-center text-[10px] font-semibold leading-4 text-white"
                >
                  {unread}
                </span>
              ) : null}
            </span>
            <MessageIcon />
            <span className="text-xs [writing-mode:vertical-rl]">
              {t("dock.title")}
            </span>
          </button>
        ) : null}

        <div
          className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] ${
            mode === "min" ? "lg:hidden" : ""
          }`}
        >
          <header
            data-component="ProjectChatDockHeader"
            className="hidden items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 lg:flex"
          >
            {avatar}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {t("dock.title")}
              </p>
              <p className="truncate text-xs text-[var(--color-muted)]">
                {t("dock.profile", { profile })}
              </p>
            </div>
            {mode === "max" ? (
              <button
                ref={restoreRef}
                type="button"
                data-action="restore-chat"
                onClick={() => dispatch({ type: "restore" })}
                title={t("dock.restoreHint")}
                aria-label={t("dock.restore")}
                className={ICON_BTN}
              >
                <RestoreIcon />
              </button>
            ) : (
              <button
                ref={maximizeRef}
                type="button"
                data-action="maximize-chat"
                onClick={() => dispatch({ type: "maximize" })}
                title={t("dock.maximizeHint")}
                aria-label={t("dock.maximize")}
                className={ICON_BTN}
              >
                <MaximizeIcon />
              </button>
            )}
            <button
              type="button"
              data-action="minimize-chat"
              onClick={() => dispatch({ type: "minimize" })}
              title={t("dock.minimizeHint")}
              aria-label={t("dock.minimize")}
              className={ICON_BTN}
            >
              <CollapseRightIcon />
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col p-2">
            {children(onMessageCount)}
          </div>
        </div>
      </aside>
    </>
  );
}
