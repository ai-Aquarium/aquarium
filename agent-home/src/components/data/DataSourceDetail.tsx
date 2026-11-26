"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { formatWhen, personName } from "@/components/sites/format";
import { useLocale, useT } from "@/i18n";
import type { DirectoryEntry } from "@/types";
import type { DataSourceDoc, DictionaryVersion } from "@/types/data";

import { DictionaryPill, HealthPill, TypeBadge, askHref } from "./DataList";
import { ConnectionHealth } from "./ConnectionHealth";
import { DictionaryDetail } from "./DictionaryDetail";
import { AssigneeCard } from "./AssigneeCard";
import { ShareSheet } from "./ShareSheet";
import { DATA_TABS, allows, healthOf, type DataTab } from "./format";

function Card({ title, children, foot }: { title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h2>
      {children}
      {foot ? <div className="mt-auto flex flex-wrap gap-2 pt-2">{foot}</div> : null}
    </section>
  );
}

/**
 * One data source (mockup v2): the same tabs for every kind — Overview,
 * Dictionary, Access, History, and Website / About / Connection.
 */
export function DataSourceDetail({
  doc,
  versions,
  directory,
  directoryError = false,
  me = "",
  initialTab = "overview",
}: {
  doc: DataSourceDoc;
  versions: DictionaryVersion[];
  directory: DirectoryEntry[];
  directoryError?: boolean;
  me?: string;
  initialTab?: DataTab;
}) {
  const t = useT("data");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname() ?? `/data/${doc.source.id}`;
  const [tab, setTab] = useState<DataTab>(initialTab);
  const [sharing, setSharing] = useState(false);
  const { source, draft } = doc;
  const people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  const manage = allows(source.access, "manage");
  const propose = allows(source.access, "propose");
  const h = healthOf(source);
  const drift = source.schema_drift ?? [];
  const [assignee, setAssignee] = useState(source.owner_user_id);
  const app = source.kind === "app";
  const owner = !assignee ? t("list.admins") : assignee === me ? t("list.you") : personName(people, assignee);
  const ownerLine = app
    ? t("assign.line", { who: assignee ? owner : t("assign.everyone") })
    : t("list.owner", { who: owner });
  const sourceTab = source.kind === "site" ? "website" : source.kind === "app" ? "about" : "connection";

  function select(next: DataTab) {
    setTab(next);
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
  }

  return (
    <div data-component="DataSourceDetail" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <TypeBadge source={source} />
        <HealthPill source={source} />
        <DictionaryPill source={source} />
        <span className="text-[var(--color-muted)]">
          · {ownerLine} · {t(`access.${source.access}`)}
        </span>
        <Link href={askHref(source.id)} className={`${primaryButtonClass} ml-auto inline-flex min-h-9 items-center`}>
          {t("detail.ask")}
        </Link>
      </div>
      <div role="tablist" aria-label={t("detail.tabsLabel")} className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)]">
        {DATA_TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            onClick={() => select(x)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === x ? "border-[var(--color-accent)] font-medium" : "border-transparent text-[var(--color-muted)]"}`}
          >
            {x === "source" ? t(`tabs.${sourceTab}`) : t(`tabs.${x}`)}
            {x === "dictionary" && (drift.length || (draft && manage)) ? <span className="ml-1 text-[var(--color-warn-text)]">●</span> : null}
            {x === "source" && h.state === "attention" ? <span className="ml-1 text-[var(--color-danger)]">●</span> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "overview" ? (
          <div className="flex flex-col gap-4">
            {h.state === "attention" ? (
              <InlineAlert tone="danger" title={t("overview.brokenTitle")}>
                {h.detail ?? t("overview.brokenBody")}
              </InlineAlert>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Card title={t("overview.connection")}>
                <div className="flex flex-wrap items-center gap-2">
                  <HealthPill source={source} />
                  {h.checked_at ? <span className="text-sm text-[var(--color-muted)]">{t("overview.checked", { when: formatWhen(h.checked_at, locale) })}</span> : null}
                </div>
                <p className="text-xs text-[var(--color-muted)]">{t(`overview.healthHint.${source.kind}`)}</p>
              </Card>
              <Card
                title={t("overview.dictionary")}
                foot={
                  <>
                    {draft && propose ? (
                      <Link href={`/data/${source.id}/review`} className="inline-flex min-h-9 items-center rounded-full border border-[var(--color-warn)] px-4 py-1.5 text-xs">
                        {manage ? t("detail.reviewDraft", { n: draft.changed_tables?.length ?? 0 }) : t("detail.seeDraft", { n: draft.changed_tables?.length ?? 0 })}
                      </Link>
                    ) : null}
                    <button type="button" className={secondaryButtonClass} onClick={() => select("dictionary")}>
                      {t("overview.openDictionary")}
                    </button>
                  </>
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <DictionaryPill source={source} />
                  {drift.length ? <Pill tone="warning">{t("status.drift")}</Pill> : null}
                </div>
                <p className="text-sm text-[var(--color-muted)]">{t("list.described", { n: source.tables_described ?? 0 })}</p>
              </Card>
              <Card
                title={t("overview.who")}
                foot={
                  <button type="button" className={secondaryButtonClass} onClick={() => select("access")}>
                    {manage ? t("overview.manageAccess") : t("overview.seeAccess")}
                  </button>
                }
              >
                {app ? null : <p className="text-sm">{ownerLine}</p>}
                <p className="text-xs text-[var(--color-muted)]">{t("access.always")}</p>
              </Card>
              {app ? (
                <AssigneeCard
                  sourceId={source.id}
                  assignee={assignee}
                  directory={directory}
                  me={me}
                  open={(draft ? 1 : 0) + (drift.length ? 1 : 0) + (h.state === "attention" ? 1 : 0)}
                  canAssign={manage}
                  onChange={setAssignee}
                />
              ) : null}
              <Card title={t("overview.linked")}>
                <ul className="flex flex-col gap-1 text-sm">
                  {source.kind === "site" && source.site_id ? (
                    <li>
                      <Link href={`/sites/${source.site_id}`} className="font-medium text-[var(--color-accent)] hover:underline">
                        {t("overview.linkedSite", { name: source.name })}
                      </Link>
                    </li>
                  ) : null}
                  {source.kind === "connection" ? (
                    <li>
                      <Link href="/settings/in-out" className="font-medium text-[var(--color-accent)] hover:underline">
                        {t("overview.linkedVpn")}
                      </Link>
                    </li>
                  ) : null}
                  {source.kind === "app" ? <li>{t("overview.builtIn")}</li> : null}
                  <li>
                    <Link href="/chat?new=1" className="font-medium text-[var(--color-accent)] hover:underline">
                      {t("overview.linkedChat")}
                    </Link>
                  </li>
                </ul>
              </Card>
            </div>
          </div>
        ) : null}
        {tab === "dictionary" ? <DictionaryDetail doc={doc} versions={versions} directory={directory} directoryError={directoryError} view="dictionary" /> : null}
        {tab === "history" ? <DictionaryDetail doc={doc} versions={versions} directory={directory} directoryError={directoryError} view="history" /> : null}
        {tab === "access" ? (
          <div data-component="DataAccess" className="flex flex-col gap-3">
            <InlineAlert tone="info">
              {t("access.always")} {t(`access.note.${source.kind}`)}{" "}
              {source.kind === "site" && source.site_id ? (
                <Link href={`/sites/${source.site_id}?tab=sharing`} className="font-medium underline">
                  {t("access.siteSharing")}
                </Link>
              ) : null}
            </InlineAlert>
            <p className="text-sm">{ownerLine}</p>
            {manage ? (
              <div>
                <button type="button" className={primaryButtonClass} onClick={() => setSharing(true)}>
                  {t("share.open")}
                </button>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">{t("access.readOnly")}</p>
            )}
            <p className="text-xs text-[var(--color-muted)]">{t("share.levels")}</p>
          </div>
        ) : null}
        {tab === "source" ? (
          <div className="flex flex-col gap-3">
            {source.kind === "app" ? <InlineAlert tone="info">{t("source.about")}</InlineAlert> : null}
            {source.kind === "site" && source.site_id ? (
              <Card
                title={t("tabs.website")}
                foot={
                  <Link href={`/sites/${source.site_id}`} className={`${primaryButtonClass} inline-flex min-h-9 items-center`}>
                    {t("source.openInSites")}
                  </Link>
                }
              >
                <p className="text-sm">{t("source.siteBody")}</p>
              </Card>
            ) : null}
            {source.kind === "connection" ? (
              <Card
                title={t("tabs.connection")}
                foot={
                  manage ? (
                    <Link href={`/data/new#${source.engine === "mssql" ? "sql-server" : (source.engine ?? "sql-server")}`} className={`${secondaryButtonClass} inline-flex min-h-9 items-center`}>
                      {t("source.manageConnection")}
                    </Link>
                  ) : null
                }
              >
                <p className="text-sm">{source.connection ?? source.name}</p>
                {manage && source.owner_user_id === me ? <ConnectionHealth source={source} /> : null}
                <p className="text-xs text-[var(--color-muted)]">{manage ? t("source.connectionBody") : t("source.connectionOwnerOnly", { who: owner })}</p>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>
      {sharing ? <ShareSheet sourceId={source.id} ownerId={source.owner_user_id} directory={directory} directoryError={directoryError} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}
