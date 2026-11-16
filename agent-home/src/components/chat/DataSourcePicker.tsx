"use client";

import { useEffect, useState } from "react";

import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n";
import { setChatDataSource } from "@/lib/chat/data-source";
import type { DataSource } from "@/types/data";

/**
 * "Ask about" above the chat composer: let the agent choose (default) or pin
 * one data source the person can read. Hidden when they have none.
 */
export function DataSourcePicker({ initialId }: { initialId?: string }) {
  const t = useT("data");
  const [sources, setSources] = useState<DataSource[] | null>(null);
  const [picked, setPicked] = useState<string>(initialId ?? "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/data/sources", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sources: DataSource[] }>) : { sources: [] }))
      .then((doc) => live && setSources(doc.sources ?? []))
      .catch(() => live && setSources([]));
    return () => {
      live = false;
    };
  }, []);

  const chosen = sources?.find((s) => s.id === picked) ?? null;
  useEffect(() => {
    setChatDataSource(chosen ? { id: chosen.id, name: chosen.name } : null);
    return () => setChatDataSource(null);
  }, [chosen]);

  if (!sources || sources.length === 0) return null;
  const choose = (id: string) => {
    setPicked(id);
    setOpen(false);
  };
  return (
    <div data-component="DataSourcePicker" className="mb-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-8 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-fg)]"
      >
        <span aria-hidden>⛁</span> {t("ask.label")} <strong>{chosen ? chosen.name : t("ask.auto")}</strong> <span aria-hidden>▾</span>
      </button>
      <span className="text-xs text-[var(--color-muted)]">{chosen ? t("ask.pinnedHint") : t("ask.autoHint")}</span>
      {open ? (
        <Sheet title={t("ask.title")} onClose={() => setOpen(false)} component="DataSourcePickerSheet">
          <ul className="flex flex-col gap-1">
            {[{ id: "", name: t("ask.auto"), note: t("ask.autoHint") }, ...sources.map((s) => ({ id: s.id, name: s.name, note: t(`kind.${s.kind}`) }))].map((o) => (
              <li key={o.id || "auto"}>
                <button
                  type="button"
                  aria-pressed={picked === o.id}
                  onClick={() => choose(o.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left hover:bg-[var(--color-surface-2)] ${picked === o.id ? "border border-[var(--color-accent)]" : ""}`}
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{o.name}</span>
                    <span className="text-xs text-[var(--color-muted)]">{o.note}</span>
                  </span>
                  {picked === o.id ? <span aria-hidden>✓</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
    </div>
  );
}
