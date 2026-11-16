"use client";

import { useState } from "react";

import { dataPath } from "@/components/data/format";
import { JSON_HEADERS, readJson } from "@/components/sites/format";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Maximizable, MaximizeToggle } from "@/components/ui/Maximizable";
import { useT } from "@/i18n";
import type { DataAnswer } from "@/lib/chat/data-answer";

const CHIP =
  "inline-flex min-h-8 items-center rounded-full px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-70";

function focusComposer() {
  const box = document.querySelector<HTMLTextAreaElement>('[data-component="Composer"] textarea');
  box?.focus();
}

/** Under an answer from data: source and version, Show SQL, "Was this right?" (Figma 63:644). */
export function DataAnswerFooter({
  answer,
  onMaximizedChange,
}: {
  answer: DataAnswer;
  onMaximizedChange?(maximized: boolean): void;
}) {
  const t = useT("data");
  const [sqlOpen, setSqlOpen] = useState(false);
  const [state, setState] = useState<"idle" | "saved" | "correcting">("idle");
  const [error, setError] = useState<string | null>(null);
  const table = answer.tables[0];

  async function saveExample() {
    setError(null);
    try {
      await readJson(
        await fetch(dataPath(answer.source_id, "feedback"), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ table, question: answer.question, sql: answer.sql }),
        }),
      );
      setState("saved");
    } catch (err) {
      setError(t("answer.failed", { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  return (
    <div data-component="DataAnswerFooter" className="mt-2 flex flex-col gap-2 text-xs">
      <p className="text-[var(--color-muted)] [overflow-wrap:anywhere]">
        {answer.version
          ? t("answer.basedOn", { source: answer.source, v: answer.version })
          : t("answer.noDictionary", { source: answer.source })}
        {answer.tables.length ? ` · ${answer.tables.join(", ")}` : ""}{" "}
        <button
          type="button"
          aria-expanded={sqlOpen}
          onClick={() => setSqlOpen((o) => !o)}
          className="text-[var(--color-accent)] hover:underline"
        >
          {sqlOpen ? t("answer.hideSql") : t("answer.showSql")}
        </button>
      </p>
      {sqlOpen ? (
        <Maximizable
          title={t("answer.sqlTitle")}
          component="DataAnswerSql"
          className="flex flex-col gap-1"
          onMaximizedChange={onMaximizedChange}
        >
          {({ maximized }) => (
            <>
              {maximized ? null : (
                <div className="flex justify-end">
                  <MaximizeToggle />
                </div>
              )}
              <pre
                tabIndex={maximized ? 0 : undefined}
                aria-label={maximized ? t("answer.sqlTitle") : undefined}
                className={`${maximized ? "min-h-0 flex-1" : "max-h-64"} overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs whitespace-pre-wrap text-[var(--color-muted)]`}
              >
                {answer.sql}
              </pre>
            </>
          )}
        </Maximizable>
      ) : null}
      {answer.undescribed.length ? (
        <InlineAlert tone="warn">{t("answer.undescribed", { tables: answer.undescribed.join(", ") })}</InlineAlert>
      ) : null}
      {state === "saved" ? (
        <p role="status" className="text-[var(--color-success)]">✓ {t("answer.saved")}</p>
      ) : state === "correcting" ? (
        <p role="status" className="text-[var(--color-muted)]">{t("answer.correctHint")}</p>
      ) : table && answer.question ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[var(--color-muted)]">{t("answer.wasRight")}</span>
          <ActionButton
            onAction={saveExample}
            busyLabel={t("answer.saving")}
            className={`${CHIP} border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg)]`}
          >
            {t("answer.yes")}
          </ActionButton>
          <button
            type="button"
            onClick={() => {
              setState("correcting");
              focusComposer();
            }}
            className={`${CHIP} text-[var(--color-muted)] hover:text-[var(--color-fg)]`}
          >
            {t("answer.no")}
          </button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}
