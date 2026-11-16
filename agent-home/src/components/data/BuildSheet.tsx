"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Sheet, primaryButtonClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { useT } from "@/i18n";
import type { DataSource } from "@/types/data";

import { schemasOf } from "./format";

export type BuildScope = { kind: "undescribed" } | { kind: "schemas"; schemas: string[] } | { kind: "changed"; tables: string[] };

/** The chat request Build dictionary opens with (never sent until the person presses send). */
export function buildPrompt(t: ReturnType<typeof useT>, source: Pick<DataSource, "kind" | "name">, scope: BuildScope, onDemand: boolean): string {
  const name = source.kind === "app" ? "app" : source.name;
  const what =
    scope.kind === "schemas"
      ? t("build.scopePrompt.schemas", { source: name, schemas: scope.schemas.join(", ") })
      : scope.kind === "changed"
        ? t("build.scopePrompt.changed", { source: name, tables: scope.tables.join(", ") })
        : t("build.prompt", { source: name });
  return onDemand ? `${what} ${t("build.onDemandPrompt")}` : what;
}

/**
 * Build dictionary: pick what the agent studies now — the schemas you pick (a
 * big source has no "all tables" study), only the changed tables, or the
 * undescribed ones — plus "study on demand" for everything else.
 */
export function BuildSheet({ source, tables, onClose }: { source: DataSource; tables: string[]; onClose(): void }) {
  const t = useT("data");
  const schemas = schemasOf(tables);
  const changed = (source.schema_drift ?? []).map((d) => d.table);
  const [kind, setKind] = useState<BuildScope["kind"]>(schemas.length ? "schemas" : "undescribed");
  const [picked, setPicked] = useState<string[]>(schemas.slice(0, 2).map((s) => s.name));
  const [onDemand, setOnDemand] = useState(true);
  const scope: BuildScope = kind === "schemas" ? { kind, schemas: picked } : kind === "changed" ? { kind, tables: changed } : { kind };
  const ready = kind !== "schemas" || picked.length > 0;
  const href = `/chat?new=1&source=${encodeURIComponent(source.id)}&draft=${encodeURIComponent(buildPrompt(t, source, scope, onDemand))}`;
  const radio = (k: BuildScope["kind"], label: string, extra?: ReactNode) => (
    <label className="flex items-start gap-2">
      <input type="radio" name="build-scope" className="mt-1" checked={kind === k} onChange={() => setKind(k)} />
      <span>
        {label}
        {extra}
      </span>
    </label>
  );
  return (
    <Sheet
      title={t("build.title", { name: source.name })}
      onClose={onClose}
      component="BuildDictionarySheet"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {t("edit.cancel")}
          </button>
          {ready ? (
            <Link href={href} className={`${primaryButtonClass} inline-flex min-h-9 items-center`}>
              {t("build.open")}
            </Link>
          ) : (
            <button type="button" disabled className={primaryButtonClass}>
              {t("build.open")}
            </button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-[var(--color-muted)]">{t("build.hint")}</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium">{t("build.scope")}</legend>
          {schemas.length
            ? radio(
                "schemas",
                t("build.scopeSchemas"),
                <span className="mt-1 flex flex-wrap gap-2 text-xs">
                  {schemas.map((s) => (
                    <label key={s.name} className="flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-1">
                      <input
                        type="checkbox"
                        checked={picked.includes(s.name)}
                        onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.name] : p.filter((x) => x !== s.name)))}
                      />
                      {s.name}
                    </label>
                  ))}
                </span>,
              )
            : radio("undescribed", t("build.scopeUndescribed"))}
          {changed.length ? radio("changed", t("build.scopeChanged", { n: changed.length })) : null}
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={onDemand} onChange={(e) => setOnDemand(e.target.checked)} />
            <span>
              {t("build.onDemand")}
              <span className="block text-xs text-[var(--color-muted)]">{t("build.onDemandHint")}</span>
            </span>
          </label>
        </fieldset>
        {schemas.length ? <p className="text-xs text-[var(--color-muted)]">{t("build.bigNote")}</p> : null}
      </div>
    </Sheet>
  );
}
