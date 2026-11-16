"use client";

import { useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { secondaryButtonClass } from "@/components/ui/Sheet";
import { formatWhen } from "@/components/sites/format";
import { useLocale, useT } from "@/i18n";
import type { DbConnectionTest, MssqlConnection } from "@/types";
import type { DataSource } from "@/types/data";

import { healthOf } from "./format";

type Result = { ok: boolean | null; at?: string | null; detail?: string | null };

/**
 * Connection tab of the owner's own connected database: Hermes' last hourly
 * check (or SQL Server's last test) and "Test now".
 */
export function ConnectionHealth({ source }: { source: DataSource }) {
  const t = useT("data");
  const locale = useLocale();
  const engine = source.engine;
  const name = source.connection ?? "";
  const [result, setResult] = useState<Result>(() => {
    const h = healthOf(source);
    return h.state === "untested" ? { ok: null } : { ok: h.state !== "attention", at: h.checked_at, detail: h.detail };
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (engine !== "mssql" || !name || source.health) return;
    let live = true;
    fetch("/api/mssql/connections", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ connections: MssqlConnection[] }>) : { connections: [] }))
      .then((doc) => {
        const c = doc.connections.find((x) => x.name === name);
        if (live && c?.last_test) setResult({ ok: c.last_test.ok, at: c.last_test.at, detail: c.last_test.error ?? null });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [engine, name, source.health]);

  if (!name || !engine || engine === "postgres") return null;

  async function test() {
    setBusy(true);
    try {
      const base = engine === "mssql" ? `/api/mssql/connections/${encodeURIComponent(name)}` : `/api/db/connections/${engine}/${encodeURIComponent(name)}`;
      const res = await fetch(`${base}/test`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      if (engine === "mssql") {
        const last = ((await res.json()) as { connection: MssqlConnection }).connection.last_test;
        setResult({ ok: last?.ok ?? false, at: last?.at ?? null, detail: last?.error ?? null });
      } else {
        const doc = (await res.json()) as DbConnectionTest;
        setResult({ ok: doc.test.ok, at: new Date().toISOString(), detail: doc.test.ok ? t("db.testOk", { n: doc.test.tables ?? 0 }) : doc.test.error ?? null });
      }
    } catch {
      setResult({ ok: false, detail: t("db.errTest") });
    } finally {
      setBusy(false);
    }
  }

  const state = result.ok === null ? "untested" : result.ok ? "ok" : "attention";
  const tone = state === "ok" ? "text-[var(--color-success)]" : state === "attention" ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]";
  return (
    <div data-component="ConnectionHealth" className="flex flex-wrap items-center gap-2 text-sm">
      <span className={`font-medium ${tone}`}>{t(`health.${state}`)}</span>
      {result.at ? <span className="text-xs text-[var(--color-muted)]">{t("overview.checked", { when: formatWhen(result.at, locale) })}</span> : null}
      {result.detail ? <span className="w-full break-words text-xs text-[var(--color-muted)]">{result.detail}</span> : null}
      <ActionButton busyLabel={t("db.testing")} className={secondaryButtonClass} disabled={busy} aria-busy={busy} onAction={test}>
        {busy ? t("db.testing") : t("source.testNow")}
      </ActionButton>
    </div>
  );
}
