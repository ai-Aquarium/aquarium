"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

import { useT } from "@/i18n";

/**
 * A panel that can be maximized to fill the screen and minimized back in place.
 *
 * The panel never remounts: maximizing only swaps its classes to `fixed
 * inset-0`, so state, typed text and scroll positions inside survive the round
 * trip. Put `<MaximizeToggle />` at the top right of the panel's own header;
 * while maximized a header strip with the title and "⤡ Minimize" takes its
 * place. Esc minimizes, unless a dialog (e.g. a `Sheet`) is open above it or an
 * inner widget handled the key (`preventDefault()`).
 *
 * Don't place it under an ancestor with `transform`, `filter` or
 * `backdrop-filter`: those trap `position: fixed` inside the ancestor.
 */

type MaximizableState = {
  maximized: boolean;
  setMaximized(next: boolean): void;
  toggle(): void;
  title: string;
};

const MaximizableContext = createContext<MaximizableState | null>(null);
const ToggleRefContext =
  createContext<RefObject<HTMLButtonElement | null> | null>(null);

/** `{ maximized, setMaximized, toggle }` of the nearest `Maximizable`. */
export function useMaximizable(): Pick<
  MaximizableState,
  "maximized" | "setMaximized" | "toggle"
> {
  const ctx = useContext(MaximizableContext);
  if (!ctx) throw new Error("useMaximizable must be used inside <Maximizable>");
  return ctx;
}

/** Small header button (same look as the other panel controls). */
export const maximizeButtonClass =
  "shrink-0 whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] lg:!min-h-0";

const MAXIMIZED_CLASS =
  "fixed inset-0 z-[65] flex h-[100dvh] flex-col overflow-hidden rounded-none border-0 border-t-[3px] border-[var(--color-accent)] bg-[var(--color-surface)] px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] lg:px-8 lg:pb-5";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Maximized panels, oldest first: only the last one answers Esc and Tab. */
const openStack: string[] = [];

/** Another modal (not a maximized panel) sits above `own`, e.g. a Sheet. */
function modalAbove(own: HTMLElement | null): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
  ).some(
    (el) =>
      el !== own && !el.hasAttribute("data-maximizable") && !el.contains(own),
  );
}

export function Maximizable({
  title,
  status,
  children,
  className = "",
  maximizedClassName = "",
  bodyClassName = "mx-auto w-full max-w-4xl gap-2",
  maximized: controlled,
  defaultMaximized = false,
  onMaximizedChange,
  component = "Maximizable",
  ...rest
}: {
  /** Shown in the maximized header strip; also the dialog's accessible name. */
  title: string;
  /** Extra context in the strip next to the title (e.g. a live status line). */
  status?: ReactNode;
  children: ReactNode | ((state: { maximized: boolean }) => ReactNode);
  /** Panel classes while minimized. */
  className?: string;
  /** Extra panel classes while maximized (added to the full-screen frame). */
  maximizedClassName?: string;
  /** Classes for the column that holds `children` while maximized. It is
   *  `display: contents` while minimized, so `className`'s layout applies. */
  bodyClassName?: string;
  maximized?: boolean;
  defaultMaximized?: boolean;
  onMaximizedChange?(maximized: boolean): void;
  component?: string;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "children" | "className">) {
  const t = useT("common");
  const id = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultMaximized);
  const maximized = controlled ?? uncontrolled;
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const minimizeRef = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const onChangeRef = useRef(onMaximizedChange);
  useEffect(() => {
    onChangeRef.current = onMaximizedChange;
  }, [onMaximizedChange]);

  const setMaximized = useCallback(
    (next: boolean) => {
      if (next === maximized) return;
      const active = document.activeElement;
      // Focus follows the control (Maximize ↔ Minimize); a textarea keeps it.
      moveFocus.current =
        !active ||
        active === document.body ||
        active === toggleRef.current ||
        active === minimizeRef.current ||
        !panelRef.current?.contains(active);
      if (controlled === undefined) setUncontrolled(next);
      onChangeRef.current?.(next);
    },
    [controlled, maximized],
  );
  const toggle = useCallback(
    () => setMaximized(!maximized),
    [maximized, setMaximized],
  );

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (maximized ? minimizeRef : toggleRef).current?.focus();
  }, [maximized]);

  useEffect(() => {
    if (!maximized) return;
    openStack.push(id);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let blocked = false;
    const isTop = () => openStack[openStack.length - 1] === id;
    // Capture runs before any other window listener, so a Sheet that is about
    // to close on this same Esc is still in the DOM when we look.
    function onCapture() {
      blocked = !isTop() || modalAbove(panelRef.current);
    }
    function onKey(e: KeyboardEvent) {
      if (blocked || e.defaultPrevented) return;
      if (e.key === "Escape") {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        setMaximized(false);
        return;
      }
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      const at = openStack.lastIndexOf(id);
      if (at >= 0) openStack.splice(at, 1);
    };
  }, [id, maximized, setMaximized]);

  const ctx = useMemo(
    () => ({ maximized, setMaximized, toggle, title }),
    [maximized, setMaximized, toggle, title],
  );

  return (
    <MaximizableContext.Provider value={ctx}>
      <ToggleRefContext.Provider value={toggleRef}>
        <section
          {...rest}
          ref={panelRef}
          data-component={component}
          data-maximizable=""
          data-maximized={maximized ? "true" : "false"}
          role={maximized ? "dialog" : rest.role}
          aria-modal={maximized ? true : undefined}
          aria-label={maximized ? title : rest["aria-label"]}
          className={
            maximized ? `${MAXIMIZED_CLASS} ${maximizedClassName}` : className
          }
        >
          {maximized ? (
            <div
              data-maximized-strip
              className="mx-auto mb-2 flex w-full shrink-0 items-center gap-2 border-b border-[var(--color-border)] pb-2"
            >
              <h2 className="min-w-0 truncate text-sm font-semibold">
                {title}
              </h2>
              {status ? (
                <div className="min-w-0 truncate text-xs text-[var(--color-muted)]">
                  {status}
                </div>
              ) : null}
              <span className="flex-1" />
              <button
                ref={minimizeRef}
                type="button"
                data-action="minimize"
                aria-label={t("minimizeNamed", { name: title })}
                title={t("minimizeHint")}
                onClick={() => setMaximized(false)}
                className={maximizeButtonClass}
              >
                {t("minimize")}
              </button>
            </div>
          ) : null}
          <div
            data-maximizable-body
            className={
              maximized
                ? `flex min-h-0 flex-1 flex-col ${bodyClassName}`
                : "contents"
            }
          >
            {typeof children === "function"
              ? children({ maximized })
              : children}
          </div>
        </section>
      </ToggleRefContext.Provider>
    </MaximizableContext.Provider>
  );
}

/** "⤢ Maximize" for the panel's header; renders nothing while maximized
 *  (the strip's "⤡ Minimize" replaces it). */
export function MaximizeToggle({
  className = maximizeButtonClass,
}: {
  className?: string;
}) {
  const t = useT("common");
  const ctx = useContext(MaximizableContext);
  const toggleRef = useContext(ToggleRefContext);
  if (!ctx) throw new Error("MaximizeToggle must be used inside <Maximizable>");
  if (ctx.maximized) return null;
  return (
    <button
      ref={toggleRef}
      type="button"
      data-action="maximize"
      aria-label={t("maximizeNamed", { name: ctx.title })}
      title={t("maximizeHint")}
      onClick={() => ctx.setMaximized(true)}
      className={className}
    >
      {t("maximize")}
    </button>
  );
}
