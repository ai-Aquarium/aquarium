"use client";

import Link from "next/link";

import { SqlServerConnections } from "@/components/settings/SqlServerConnections";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { ChevronRightIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";

import { DbConnections } from "./DbConnections";
import { SOURCE_GLYPH, type SourceType } from "./format";

function Choice({ type, title, body, href, note }: { type: SourceType | "sheet" | "api"; title: string; body: string; href?: string; note?: string }) {
  const glyph = type === "sheet" ? "▦" : type === "api" ? "⇄" : SOURCE_GLYPH[type];
  const inner = (
    <>
      <span className="flex items-center justify-between gap-2 font-semibold text-[var(--color-fg)]">
        <span className="flex items-center gap-2">
          <span aria-hidden className="text-[var(--color-accent)]">
            {glyph}
          </span>
          {title}
        </span>
        {href ? <ChevronRightIcon size={16} /> : note ? <Pill>{note}</Pill> : null}
      </span>
      <span className="text-sm text-[var(--color-muted)]">{body}</span>
    </>
  );
  return href ? (
    <Link href={href} data-choice={type} className="flex min-h-24 flex-col gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-accent)]">
      {inner}
    </Link>
  ) : (
    <div data-choice={type} aria-disabled="true" className="flex min-h-24 flex-col gap-1 rounded-2xl border border-dashed border-[var(--color-border)] p-4 opacity-80">
      {inner}
    </div>
  );
}

/**
 * Add data source (mockup v2): connect a database (SQL Server, MySQL, SQLite;
 * PostgreSQL once it has a connection API) or turn a website into tables.
 */
export function AddDataSource({ canAddSite, isOwner, isAdmin = isOwner }: { canAddSite: boolean; isOwner: boolean; isAdmin?: boolean }) {
  const t = useT("data");
  const h2 = "text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]";
  return (
    <div data-component="AddDataSource" className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className={h2}>{t("add.connect")}</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Choice type="mssql" title={t("type.mssql")} body={t("add.mssqlBody")} href="#sql-server" />
          <Choice type="mysql" title={t("type.mysql")} body={t("add.mysqlBody")} href="#mysql" />
          <Choice type="postgres" title={t("type.postgres")} body={t("add.postgresBody")} note={t("add.soon")} />
          <Choice type="sqlite" title={t("type.sqlite")} body={t("add.sqliteBody")} href="#sqlite" />
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className={h2}>{t("add.website")}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Choice type="site" title={t("type.site")} body={t("add.siteBody")} href={canAddSite ? "/sites/new" : undefined} note={canAddSite ? undefined : t("add.siteLocked")} />
        </div>
        {canAddSite ? null : <p className="text-[13px] text-[var(--color-muted)]">{t("add.siteLockedBody")}</p>}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className={h2}>{t("add.later")}</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Choice type="sheet" title={t("add.sheet")} body={t("add.sheetBody")} note={t("add.laterPill")} />
          <Choice type="api" title={t("add.api")} body={t("add.apiBody")} note={t("add.laterPill")} />
        </div>
      </section>
      <section id="sql-server" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <SqlServerConnections isOwner={isOwner} />
      </section>
      <section id="mysql" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <DbConnections engine="mysql" />
      </section>
      <section id="sqlite" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <DbConnections engine="sqlite" canAdd={isAdmin} />
      </section>
      <InlineAlert tone="info">{t("add.privateNote")}</InlineAlert>
    </div>
  );
}
