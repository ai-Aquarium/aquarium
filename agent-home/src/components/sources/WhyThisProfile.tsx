"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { RoutingDecisionCard, routingDecisionTitle } from "@/components/sources/RoutingDecisionCard";
import { XIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useT, type Translator } from "@/i18n";
import type { RoutingDecision } from "@/types";

/** Popover at `lg` and up (the landing's desktop breakpoint); a bottom sheet below. */
const DESKTOP_QUERY = "(min-width: 1024px)";
const POPOVER_WIDTH = 440;
const EDGE = 16;

interface Place {
  top: number;
  left: number;
}

/** Below the link, kept on screen; fixed so a scrolling panel can't clip it. */
function placeBelow(el: HTMLElement, align: "start" | "end"): Place {
  const r = el.getBoundingClientRect();
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * EDGE);
  const want = align === "end" ? r.right - width : r.left;
  return { top: r.bottom + 8, left: Math.max(EDGE, Math.min(want, window.innerWidth - width - EDGE)) };
}

type Load =
  | { status: "idle" | "loading" | "error" | "missing" }
  | { status: "ready"; decision: RoutingDecision };

export interface WhyThisProfileProps {
  sourceId?: string | null;
  batchId?: string | null;
  /** The profile the item was raised in ("Why CFO got this"). */
  profile?: string | null;
  /** Which edge of the link the desktop popover lines up with. */
  align?: "start" | "end";
  /** Where "Recent routing for …" goes (the Sources page); the link is hidden without it. */
  recentRoutingHref?: (sourceId: string) => string;
  className?: string;
}

/**
 * FG-03 P7 (Figma 4a / 4b): the "Why this profile?" link on a triaged to-do
 * or Needs You item. Renders nothing without routing info; otherwise one tap
 * loads that batch's decision once and shows it in a popover (desktop) or a
 * bottom sheet (phone), each closable by its X, Esc or an outside press.
 */
export function WhyThisProfile({ sourceId, batchId, ...rest }: WhyThisProfileProps) {
  if (!sourceId || !batchId) return null;
  return <WhyThisProfileLink sourceId={sourceId} batchId={batchId} {...rest} />;
}

function WhyThisProfileLink({
  sourceId,
  batchId,
  profile,
  align = "start",
  recentRoutingHref,
  className = "",
}: WhyThisProfileProps & { sourceId: string; batchId: string }) {
  const t = useT("routing");
  const [place, setPlace] = useState<Place | null>(null);
  const popOpen = place !== null;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const inFlight = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const fetchDecision = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoad({ status: "loading" });
    try {
      const qs = new URLSearchParams({ source_id: sourceId, batch_id: batchId, limit: "1" });
      const res = await fetch(`/api/sources/decisions?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { decisions?: RoutingDecision[] };
      const decision = body.decisions?.find((d) => d.batch_id === batchId) ?? body.decisions?.[0];
      setLoad(decision ? { status: "ready", decision } : { status: "missing" });
    } catch {
      setLoad({ status: "error" });
    } finally {
      inFlight.current = false;
    }
  }, [sourceId, batchId]);

  const open = popOpen || sheetOpen;
  const toggle = () => {
    if (open) {
      setPlace(null);
      setSheetOpen(false);
      return;
    }
    if (window.matchMedia(DESKTOP_QUERY).matches && trigger.current) setPlace(placeBelow(trigger.current, align));
    else setSheetOpen(true);
    if (load.status === "idle" || load.status === "error") void fetchDecision();
  };

  const closePopover = useCallback(() => {
    setPlace(null);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!popOpen) return;
    panel.current?.focus();
    const follow = () => {
      if (trigger.current) setPlace(placeBelow(trigger.current, align));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopover();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setPlace(null);
    };
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [popOpen, align, closePopover]);

  const title =
    load.status === "ready"
      ? routingDecisionTitle(t, load.decision, profile)
      : profile
        ? t("titleOne", { profile })
        : t("whyLink");

  const body = (
    <DecisionBody
      t={t}
      load={load}
      profile={profile}
      recentHref={recentRoutingHref?.(sourceId) ?? null}
      sourceId={sourceId}
      onRetry={() => void fetchDecision()}
    />
  );

  return (
    <span data-component="WhyThisProfile" className={`inline-block ${className}`}>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="text-xs font-medium leading-4 text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:underline"
      >
        {t("whyLink")}
      </button>
      {place
        ? createPortal(
        <div
          ref={panel}
          role="dialog"
          aria-label={title}
          tabIndex={-1}
          data-testid="why-this-profile-popover"
          style={{ top: place.top, left: place.left, maxHeight: `calc(100vh - ${place.top + EDGE}px)` }}
          className="fixed z-50 flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left shadow-[0_8px_24px_rgba(0,0,0,0.4)] outline-none"
        >
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-sm font-semibold leading-5 text-[var(--color-fg)]">{title}</h2>
            <button
              type="button"
              onClick={closePopover}
              aria-label={t("close")}
              className="-m-1 rounded-md p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          {body}
        </div>
      ,
          document.body,
        )
        : null}
      {sheetOpen ? (
        <Sheet title={title} onClose={() => setSheetOpen(false)} component="WhyThisProfileSheet">
          {body}
        </Sheet>
      ) : null}
    </span>
  );
}

function DecisionBody({
  t,
  load,
  profile,
  recentHref,
  sourceId,
  onRetry,
}: {
  t: Translator;
  load: Load;
  profile?: string | null;
  recentHref: string | null;
  sourceId: string;
  onRetry(): void;
}) {
  if (load.status === "ready") {
    return <ReadyBody t={t} decision={load.decision} profile={profile} recentHref={recentHref} sourceId={sourceId} />;
  }
  if (load.status === "idle" || load.status === "loading") {
    return (
      <p role="status" className="flex items-center gap-2 text-[13px] leading-[18px] text-[var(--color-muted)]">
        <Spinner /> {t("loading")}
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <InlineAlert tone="danger">
        <span className="flex flex-wrap items-center gap-x-2">
          {t("loadError")}
          <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
            {t("tryAgain")}
          </button>
        </span>
      </InlineAlert>
    );
  }
  return <p className="text-[13px] leading-[18px] text-[var(--color-muted)]">{t("missing")}</p>;
}

function ReadyBody({
  t,
  decision,
  profile,
  recentHref,
  sourceId,
}: {
  t: Translator;
  decision: RoutingDecision;
  profile?: string | null;
  recentHref: string | null;
  sourceId: string;
}) {
  const sender = decision.first_sender?.trim();
  return (
    <div className="flex flex-col gap-3">
      <RoutingDecisionCard decision={decision} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium leading-4">
        {recentHref ? (
          <Link href={recentHref} className="text-[var(--color-accent)] underline-offset-2 hover:underline">
            {t("recentRouting", { sender: sender || sourceId })}
          </Link>
        ) : null}
        {profile ? (
          <Link href="/profiles" className="text-[var(--color-accent)] underline-offset-2 hover:underline">
            {t("editCares", { profile })}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
