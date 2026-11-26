"use client";

import { useEffect, useRef, useState } from "react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { personName, readJson, JSON_HEADERS } from "@/components/sites/format";
import { useT } from "@/i18n";
import type { DirectoryEntry } from "@/types";

import { dataPath } from "./format";

function Initial({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)]/15 text-xs font-semibold text-[var(--color-accent)]"
    >
      {name ? name.slice(0, 1).toUpperCase() : "⋯"}
    </span>
  );
}

/**
 * "Assigned to" (mockup 2026-11-26): who gets Aquarium data's dictionary and
 * health cards in Needs you. No one = every owner and admin, tagged Team.
 * Access is unchanged; Hermes re-checks caller and assignee.
 */
export function AssigneeCard({
  sourceId,
  assignee,
  directory,
  me,
  open,
  canAssign,
  onChange,
}: {
  sourceId: string;
  assignee: string;
  directory: DirectoryEntry[];
  me: string;
  /** Needs you cards this source raises right now. */
  open: number;
  canAssign: boolean;
  onChange: (userId: string) => void;
}) {
  const t = useT("data");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const admins = directory.filter((p) => p.role === "owner" || p.role === "admin");
  const people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  const name = (id: string) => personName(people, id);
  const who = assignee ? name(assignee) : t("assign.everyone");

  useEffect(() => {
    if (!picking) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [picking]);

  async function pick(userId: string) {
    setPicking(false);
    if (userId === assignee) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await readJson(
        await fetch(dataPath(sourceId, "assignee"), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ user_id: userId }) }),
      );
      onChange(userId);
      setNote(userId ? t("assign.saved", { who: name(userId) }) : t("assign.cleared"));
    } catch (err) {
      setError(t("assign.failed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  const options = [{ user_id: "", display: t("assign.none"), hint: t("assign.noneHint") }, ...admins.map((p) => ({
    user_id: p.user_id,
    display: p.display || p.user_id,
    hint: `${t(`assign.role.${p.role}`)}${p.user_id === me ? ` · ${t("list.you")}` : ""}`,
  }))];

  return (
    <section
      data-component="AssigneeCard"
      className="flex flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:col-span-2"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{t("assign.title")}</h2>
      {canAssign ? (
        <div ref={box} className="relative">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={picking}
            aria-label={`${t("assign.pick")}: ${who}`}
            disabled={busy}
            data-appmcp-hint="Choose who gets this data source's Needs you to-dos"
            onClick={() => setPicking((v) => !v)}
            className="flex w-full max-w-sm items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-left text-sm hover:border-[var(--color-accent)] disabled:opacity-60"
          >
            <Initial name={assignee ? name(assignee) : ""} />
            <span className="font-medium">{who}</span>
            <span aria-hidden className="ml-auto text-[var(--color-muted)]">▾</span>
          </button>
          {picking ? (
            <div
              role="listbox"
              aria-label={t("assign.pick")}
              className="absolute left-0 top-full z-20 mt-1 w-80 max-w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-lg"
            >
              {options.map((o) => (
                <button
                  key={o.user_id || "none"}
                  type="button"
                  role="option"
                  aria-selected={o.user_id === assignee}
                  data-appmcp-hint="Assign the data source to this person (No one: every owner and admin)"
                  onClick={() => void pick(o.user_id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--color-bg)] aria-selected:bg-[var(--color-accent)]/10"
                >
                  <Initial name={o.user_id ? o.display : ""} />
                  <span className="flex flex-col">
                    <span className="font-medium">{o.display}</span>
                    <span className="text-xs text-[var(--color-muted)]">{o.hint}</span>
                  </span>
                  {o.user_id === assignee ? <span aria-hidden className="ml-auto text-[var(--color-accent)]">✓</span> : null}
                </button>
              ))}
              <p className="px-2 pb-1 pt-2 text-xs text-[var(--color-muted)]">{t("assign.onlyAdmins")}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm font-medium">{who}</p>
      )}
      <p className="text-sm text-[var(--color-muted)]">{assignee ? t("assign.explainOne", { who }) : t("assign.explainNone")}</p>
      {admins.length ? (
        <>
          <h3 className="mt-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{t("assign.gets")}</h3>
          <ul className="flex flex-col gap-1.5">
            {admins.map((p) => {
              const gets = !assignee || assignee === p.user_id;
              return (
                <li key={p.user_id} className="flex items-center gap-2 text-sm">
                  <Initial name={p.display || p.user_id} />
                  <span>{p.display || p.user_id}</span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {t(`assign.role.${p.role}`)}
                    {p.user_id === me ? ` · ${t("list.you")}` : ""}
                  </span>
                  <span className="ml-auto">
                    <Pill tone={gets && open ? "warning" : "muted"}>
                      {gets ? t(assignee ? "assign.count" : "assign.countTeam", { n: open }) : t("assign.nothing")}
                    </Pill>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <p className="text-xs text-[var(--color-muted)]">{t("assign.foot")}</p>
      {note ? (
        <p role="status" className="text-sm text-[var(--color-muted)]">
          {note}
        </p>
      ) : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    </section>
  );
}
