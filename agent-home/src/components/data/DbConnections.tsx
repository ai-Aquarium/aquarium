"use client";

/**
 * Add data source → PostgreSQL / MySQL / SQLite: the signed-in person's own connections
 * (`/api/db/connections`, private to them until shared from Data › Access;
 * the password is write-only). "Save and test" saves, then opens the
 * connection and counts its tables. Hermes checks each one hourly after that.
 */
import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";
import type { DbConnection, DbConnectionInput, DbConnectionTest, DbEngine, DbTls, VpnView } from "@/types";

export interface DbFormValues {
  name: string;
  label: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  tls: DbTls;
  vpn: string;
  path: string;
}

const EMPTY: DbFormValues = {
  name: "", label: "", host: "", port: "", database: "", username: "", password: "",
  tls: "verify", vpn: "", path: "",
};

const DEFAULT_PORT: Partial<Record<DbEngine, string>> = { postgres: "5432", mysql: "3306" };
const HOST_PLACEHOLDER: Partial<Record<DbEngine, string>> = { postgres: "pg01.yourcompany.local", mysql: "mysql01.yourcompany.local" };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Form → request body, or the message key of the problem to show. */
export function toDbInput(engine: DbEngine, v: DbFormValues, editing: boolean): { body: DbConnectionInput } | { problem: string } {
  if (!v.name.trim()) return { problem: "errRequired" };
  if (!NAME_RE.test(v.name.trim())) return { problem: "errName" };
  const label = v.label.trim() ? { label: v.label.trim() } : {};
  if (engine === "sqlite") {
    return v.path.trim() ? { body: { ...label, path: v.path.trim() } } : { problem: "errRequired" };
  }
  if ([v.host, v.database, v.username].some((x) => !x.trim())) return { problem: "errRequired" };
  let port: number | null = null;
  if (v.port.trim()) {
    port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: "errPort" };
  }
  if (!editing && !v.password) return { problem: "errPassword" };
  return {
    body: {
      ...label,
      host: v.host.trim(),
      port,
      database: v.database.trim(),
      username: v.username.trim(),
      ...(v.password ? { password: v.password } : {}),
      tls: v.tls,
      vpn: v.vpn,
    },
  };
}

function fromConnection(c: DbConnection): DbFormValues {
  return {
    ...EMPTY,
    name: c.name, label: c.label ?? "", host: c.host ?? "", port: c.port == null ? "" : String(c.port),
    database: c.database ?? "", username: c.username ?? "", tls: c.tls ?? "verify", vpn: c.vpn ?? "", path: c.path ?? "",
  };
}

const inputCls = "w-full rounded border border-[var(--color-surface-2)] bg-transparent px-2 py-1 text-xs";
const labelCls = "block space-y-1 text-xs text-[var(--color-muted)]";
const btnCls = "rounded border border-[var(--color-surface-2)] px-2 py-1 text-xs font-semibold disabled:opacity-50";
const primaryBtnCls =
  "rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50";

async function readError(res: Response): Promise<string> {
  try {
    const doc = (await res.json()) as { detail?: string; error?: string };
    return doc.detail || doc.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

const path = (engine: DbEngine, name: string) => `/api/db/connections/${engine}/${encodeURIComponent(name)}`;

export function DbConnections({ engine }: { engine: DbEngine }) {
  const t = useT("data");
  const [connections, setConnections] = useState<DbConnection[] | null>(null);
  const [driver, setDriver] = useState(true);
  const [vpns, setVpns] = useState<string[]>([]);
  const [tests, setTests] = useState<Record<string, DbConnectionTest["test"]>>({});
  const [form, setForm] = useState<{ values: DbFormValues; editing: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/db/connections", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const doc = (await res.json()) as { connections: DbConnection[]; drivers?: Record<string, boolean> };
      setConnections(doc.connections.filter((c) => c.engine === engine));
      setDriver(doc.drivers?.[engine] !== false);
      setError(null);
    } catch {
      setConnections((c) => c ?? []);
      setError(t("db.errLoad"));
    }
  }, [engine, t]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
      if (engine !== "sqlite") {
        fetch("/api/vpn", { cache: "no-store" })
          .then((r) => (r.ok ? (r.json() as Promise<{ vpns?: VpnView[] }>) : { vpns: [] }))
          .then((doc) => setVpns((doc.vpns ?? []).filter((v) => v && v.name).map((v) => v.name)))
          .catch(() => undefined);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [engine, load]);

  const upsert = (c: DbConnection) => setConnections((list) => [...(list ?? []).filter((x) => x.name !== c.name), c]);
  const setField = <K extends keyof DbFormValues>(field: K, value: DbFormValues[K]) =>
    setForm((f) => (f ? { ...f, values: { ...f.values, [field]: value } } : f));

  async function runTest(name: string) {
    setBusy(name);
    try {
      const res = await fetch(`${path(engine, name)}/test`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const doc = (await res.json()) as DbConnectionTest;
      upsert(doc.connection);
      setTests((m) => ({ ...m, [name]: doc.test }));
    } catch {
      setError(t("db.errTest"));
    } finally {
      setBusy(null);
    }
  }

  async function saveAndTest() {
    if (!form || busy) return;
    const parsed = toDbInput(engine, form.values, form.editing);
    if ("problem" in parsed) {
      setError(t(`db.${parsed.problem}`));
      return;
    }
    const name = form.values.name.trim();
    setBusy(name);
    setError(null);
    try {
      const res = await fetch(path(engine, name), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.body),
      });
      if (!res.ok) {
        setError(t("db.errSave", { reason: await readError(res) }));
        return;
      }
      upsert(((await res.json()) as { connection: DbConnection }).connection);
      setForm(null);
      await runTest(name);
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    setBusy(name);
    try {
      const res = await fetch(path(engine, name), { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      setConnections((list) => (list ?? []).filter((c) => c.name !== name));
      setRemoving(null);
    } catch {
      setError(t("db.errRemove"));
    } finally {
      setBusy(null);
    }
  }

  const { run: saveOnce } = useAction(saveAndTest);
  const v = form?.values;
  const vpnChoices = v?.vpn && !vpns.includes(v.vpn) ? [...vpns, v.vpn] : vpns;

  return (
    <section data-component="DbConnections" data-engine={engine}>
      <h2 className="text-sm font-semibold">{t(`db.title.${engine}`)}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t(`db.description.${engine}`)}</p>
      {!driver && <p className="mb-2 text-xs text-[var(--color-danger)]">{t("db.driverMissing")}</p>}
      {error && (
        <p role="alert" className="mb-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
      {connections === null && <p className="text-xs text-[var(--color-muted)]">{t("db.loading")}</p>}
      {connections && connections.length > 0 && (
        <ul className="mb-3 space-y-2">
          {connections.map((c) => {
            const test = tests[c.name];
            return (
              <li key={c.name} data-component="DbConnectionRow" className="rounded border border-[var(--color-surface-2)] p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-semibold">{c.label || c.name}</span>
                  <span className={test ? (test.ok ? "text-[var(--color-accent)]" : "text-[var(--color-danger)]") : "text-[var(--color-muted)]"}>
                    {test ? (test.ok ? t("health.ok") : t("health.attention")) : t("health.untested")}
                  </span>
                </div>
                <p className="mt-1 break-all text-[var(--color-muted)]">
                  {engine === "sqlite"
                    ? c.path
                    : `${c.host}:${c.port} · ${c.database} · ${c.username}${c.vpn ? ` · ${t("db.viaVpn", { vpn: c.vpn })}` : ""} · ${t("db.readOnly")}`}
                </p>
                {test ? (
                  <p className={`mt-1 break-words ${test.ok ? "text-[var(--color-muted)]" : "text-[var(--color-danger)]"}`}>
                    {test.ok ? t("db.testOk", { n: test.tables ?? 0 }) : t("db.testFail", { reason: test.error ?? "" })}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={btnCls} disabled={!!busy} aria-busy={busy === c.name} onClick={() => void runTest(c.name)}>
                    {busy === c.name ? t("db.testing") : t("db.test")}
                  </button>
                  <button type="button" className={btnCls} disabled={!!busy} onClick={() => setForm({ values: fromConnection(c), editing: true })}>
                    {t("db.edit")}
                  </button>
                  <button type="button" className={`${btnCls} text-[var(--color-danger)]`} disabled={!!busy} onClick={() => setRemoving(c.name)}>
                    {t("db.remove")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {connections && !form && (
        <button type="button" className={btnCls} disabled={!!busy} onClick={() => setForm({ values: { ...EMPTY, port: DEFAULT_PORT[engine] ?? "" }, editing: false })}>
          {t(`db.add.${engine}`)}
        </button>
      )}
      {v && (
        <form
          data-db-form={engine}
          className="space-y-3 rounded border border-[var(--color-surface-2)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveOnce();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label className={labelCls}>
              <span>{t("db.name")}</span>
              <input className={inputCls} placeholder={t("db.namePlaceholder")} value={v.name} disabled={form?.editing} onChange={(e) => setField("name", e.target.value)} />
            </label>
            <label className={labelCls}>
              <span>{t("db.label")}</span>
              <input className={inputCls} value={v.label} onChange={(e) => setField("label", e.target.value)} />
            </label>
            {engine === "sqlite" ? (
              <label className={`${labelCls} md:col-span-2`}>
                <span>{t("db.path")}</span>
                <input className={inputCls} placeholder={t("db.pathPlaceholder")} value={v.path} onChange={(e) => setField("path", e.target.value)} />
              </label>
            ) : (
              <>
                <label className={labelCls}>
                  <span>{t("db.host")}</span>
                  <input className={inputCls} placeholder={HOST_PLACEHOLDER[engine]} value={v.host} onChange={(e) => setField("host", e.target.value)} />
                </label>
                <label className={labelCls}>
                  <span>{t("db.port")}</span>
                  <input className={inputCls} inputMode="numeric" value={v.port} onChange={(e) => setField("port", e.target.value)} />
                </label>
                <label className={labelCls}>
                  <span>{t("db.database")}</span>
                  <input className={inputCls} value={v.database} onChange={(e) => setField("database", e.target.value)} />
                </label>
                <label className={labelCls}>
                  <span>{t("db.username")}</span>
                  <input className={inputCls} autoComplete="off" value={v.username} onChange={(e) => setField("username", e.target.value)} />
                </label>
                <label className={labelCls}>
                  <span>{t("db.password")}</span>
                  <input
                    className={inputCls}
                    type="password"
                    aria-label={t("db.password")}
                    autoComplete="new-password"
                    value={v.password}
                    placeholder={form?.editing ? "••••••••" : ""}
                    onChange={(e) => setField("password", e.target.value)}
                  />
                  {form?.editing && <span className="block">{t("db.passwordKept")}</span>}
                </label>
                <label className={labelCls}>
                  <span>{t("db.tls")}</span>
                  <select className={`${inputCls} bg-[var(--color-surface)]`} value={v.tls} onChange={(e) => setField("tls", e.target.value as DbTls)}>
                    <option value="verify">{t("db.tlsVerify")}</option>
                    <option value="on">{t("db.tlsOn")}</option>
                    <option value="off">{t("db.tlsOff")}</option>
                  </select>
                </label>
                <label className={labelCls}>
                  <span>{t("db.vpn")}</span>
                  <select className={`${inputCls} bg-[var(--color-surface)]`} value={v.vpn} onChange={(e) => setField("vpn", e.target.value)}>
                    <option value="">{t("db.vpnNone")}</option>
                    {vpnChoices.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
          <p className="text-xs text-[var(--color-muted)]">{t("db.readOnlyNote")}</p>
          <div className="flex gap-2">
            <button type="submit" className={primaryBtnCls} disabled={!!busy} aria-busy={!!busy}>
              {busy ? t("db.testing") : t("db.saveTest")}
            </button>
            <button type="button" className={btnCls} disabled={!!busy} onClick={() => setForm(null)}>
              {t("edit.cancel")}
            </button>
          </div>
        </form>
      )}
      {removing && (
        <ConfirmDialog
          title={t("db.removeTitle", { name: removing })}
          body={t("db.removeBody")}
          confirmLabel={t("db.remove")}
          cancelLabel={t("edit.cancel")}
          busy={busy === removing}
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
