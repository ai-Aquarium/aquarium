"use client";

import { useCallback, useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { CredentialForm, SubmitLabel } from "@/components/ui/CredentialForm";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";
import type { FleetBox, FleetJobs, FleetStatus, FleetSwitchJob } from "@/types";

const POLL_MS = 3000;
const CARD =
  "mb-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const CHIP =
  "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-px text-[11px]";
const CHIP_OK = `${CHIP} border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-success)]`;
const CHIP_BAD = `${CHIP} border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[var(--color-danger)]`;
const CHIP_ACCENT = `${CHIP} border-[var(--color-accent)] text-[var(--color-accent)]`;
const CHIP_MUTED = `${CHIP} border-[var(--color-border)] text-[var(--color-muted)]`;
const BTN =
  "min-h-11 rounded-full border border-[var(--color-border)] px-4 text-sm disabled:opacity-50";
const BTN_PRIMARY =
  "min-h-11 rounded-full bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50";

type Confirm = { box: FleetBox; layout: "git" | "release" } | null;

function layoutLabel(
  layout: "release" | "git" | null | undefined,
  t: (key: string) => string,
): string {
  if (layout === "git") return t("layout.git");
  if (layout === "release") return t("layout.release");
  return t("layout.unknown");
}

/**
 * Settings → Fleet: the boxes this server manages, one card each — what runs
 * where and a switch between direct deploy (git layout) and software upgrade
 * (release layout). Owner only; absent on servers that manage no fleet.
 */
export function FleetView({ initial }: { initial: FleetStatus }) {
  const t = useT("fleet");
  const [status, setStatus] = useState<FleetStatus>(initial);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const boxes = status.boxes ?? [];
  const switching = boxes.some((b) => b.switch?.state === "running");

  const reload = useCallback(async () => {
    const res = await fetch("/api/fleet", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    setStatus((await res.json()) as FleetStatus);
  }, []);

  // While a switch runs, poll its unit on the target box; when it finishes the
  // full reload picks up the new layout.
  useEffect(() => {
    if (!switching) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch("/api/fleet/job", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as FleetJobs;
        if (stopped || !next.jobs) return;
        let done = false;
        setStatus((cur) => ({
          ...cur,
          boxes: (cur.boxes ?? []).map((b) => {
            const job = next.jobs?.[b.name];
            if (!job) return b;
            if (job.state !== "running") done = true;
            return { ...b, switch: job };
          }),
        }));
        if (done) await reload().catch(() => undefined);
      } catch {
        // the poll keeps its last state; the next tick tries again
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [switching, reload]);

  if (!status.available) {
    return (
      <div data-component="FleetView" data-appmcp-hint="Fleet settings page, not set up on this server">
        <InlineAlert tone="info">{status.error || t("unavailable")}</InlineAlert>
      </div>
    );
  }

  return (
    <div data-component="FleetView">
      {boxes.length === 0 ? (
        <InlineAlert tone="info">{t("empty")}</InlineAlert>
      ) : (
        <ul className="flex flex-col">
          {boxes.map((box) => (
            <li key={box.name}>
              <BoxCard box={box} onSwitch={(layout) => setConfirm({ box, layout })} />
            </li>
          ))}
        </ul>
      )}
      {confirm ? (
        <ConfirmDialog
          confirm={confirm}
          onCancel={() => setConfirm(null)}
          onStarted={(name, job) => {
            setConfirm(null);
            setStatus((cur) => ({
              ...cur,
              boxes: (cur.boxes ?? []).map((b) =>
                b.name === name ? { ...b, switch: job } : b,
              ),
            }));
          }}
        />
      ) : null}
    </div>
  );
}

function BoxCard({
  box,
  onSwitch,
}: {
  box: FleetBox;
  onSwitch: (layout: "git" | "release") => void;
}) {
  const t = useT("fleet");
  const layout = box.installed?.layout ?? null;
  const sw = box.switch ?? null;
  const job = box.job ?? null;
  const switchRunning = sw?.state === "running";
  const upgradeBusy = Boolean(job && !job.result);
  const target: "git" | "release" | null =
    layout === "release" ? "git" : layout === "git" ? "release" : null;
  const canSwitch =
    box.reachable && target !== null && !switchRunning && !upgradeBusy;

  return (
    <section className={CARD} data-box={box.name}>
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">{box.label}</h2>
        {box.self ? (
          <span className={CHIP_ACCENT}>{t("thisBox")}</span>
        ) : null}
        {layout ? (
          <span className={layout === "release" ? CHIP_OK : CHIP_ACCENT}>
            {layoutLabel(layout, t)}
          </span>
        ) : null}
        {!box.reachable ? (
          <span className={CHIP_BAD}>{t("unreachable")}</span>
        ) : null}
      </header>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-[var(--color-muted)]">{t("running")}</dt>
        <dd className="min-w-0 truncate">
          {box.installed?.label || box.installed?.version || box.installed?.commit || "—"}
          {box.installed?.channel ? (
            <span className="text-[var(--color-muted)]"> · {box.installed.channel}</span>
          ) : null}
        </dd>
      </dl>
      {!box.reachable && box.error ? (
        <p className="mt-2 text-xs text-[var(--color-danger)]">{box.error}</p>
      ) : null}
      {job ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
          {!job.result ? <Spinner /> : null}
          {job.result
            ? t("job.last", { result: job.result, to: job.to ?? "—" })
            : t("job.running", { phase: job.phase ?? "…", to: job.to ?? "—" })}
        </p>
      ) : null}
      {sw ? <SwitchProgress job={sw} /> : null}
      <div className="mt-3 flex justify-end">
        {target ? (
          <ActionButton
            type="button"
            className={BTN}
            disabled={!canSwitch}
            title={
              canSwitch
                ? undefined
                : !box.reachable
                  ? t("hint.unreachable")
                  : switchRunning
                    ? t("hint.switchRunning")
                    : upgradeBusy
                      ? t("hint.upgradeBusy")
                      : undefined
            }
            data-appmcp-hint={`Switch ${box.label} to ${target === "git" ? "direct deploy" : "software upgrade"}`}
            onAction={() => onSwitch(target)}
          >
            {target === "git" ? t("switch.toGit") : t("switch.toRelease")}
          </ActionButton>
        ) : (
          <span className={CHIP_MUTED}>{t("layout.unknown")}</span>
        )}
      </div>
    </section>
  );
}

function SwitchProgress({ job }: { job: FleetSwitchJob }) {
  const t = useT("fleet");
  const running = job.state === "running";
  const stateText = running
    ? t("switch.running", { to: layoutLabel(job.to, t) })
    : job.state === "ok"
      ? t("switch.ok", { to: layoutLabel(job.to, t) })
      : t("switch.failed");
  return (
    <div
      className={`mt-3 rounded-xl border p-3 text-xs ${
        job.state === "failed"
          ? "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10"
          : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
      }`}
      data-component="FleetSwitchProgress"
    >
      <p className="flex items-center gap-2 font-medium">
        {running ? <Spinner /> : null}
        {stateText}
        {job.by ? <span className="text-[var(--color-muted)]">{t("by", { by: job.by })}</span> : null}
      </p>
      {job.log.length ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-muted)]">
          {job.log.slice(-12).join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

/* ── confirm with password ─────────────────────────────────────────── */

function ConfirmDialog({
  confirm,
  onCancel,
  onStarted,
}: {
  confirm: NonNullable<Confirm>;
  onCancel: () => void;
  onStarted: (box: string, job: FleetSwitchJob | null) => void;
}) {
  const t = useT("fleet");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toGit = confirm.layout === "git";
  const label = confirm.box.label;
  const { run: submit, pending: busy } = useAction(async () => {
    setError(null);
    try {
      const res = await fetch("/api/fleet/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          box: confirm.box.name,
          layout: confirm.layout,
          password,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        box?: string;
        job?: FleetSwitchJob | null;
        detail?: string;
      };
      if (!res.ok || body.box !== confirm.box.name)
        throw new Error(body.detail ?? String(res.status));
      onStarted(confirm.box.name, body.job ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <CredentialForm
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
        }}
        data-component="FleetSwitchConfirm"
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-[var(--color-surface)] p-5"
      >
        <h2 className="text-base font-semibold">
          {toGit ? t("confirm.toGit", { box: label }) : t("confirm.toRelease", { box: label })}
        </h2>
        <ul className="my-3 list-disc pl-5 text-xs">
          {(toGit
            ? [t("bullet.git.branch"), t("bullet.git.build"), t("bullet.git.back")]
            : [t("bullet.release.seal"), t("bullet.release.update"), t("bullet.release.back")]
          ).map((b) => (
            <li key={b} className="my-1">
              {b}
            </li>
          ))}
        </ul>
        <label
          className="mb-1 mt-3 block text-xs font-medium text-[var(--color-muted)]"
          htmlFor="fleet-password"
        >
          {t("password")}
        </label>
        <input
          id="fleet-password"
          type="password"
          data-appmcp-hint="Enter your password to confirm the layout switch"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
          autoFocus
        />
        {error ? (
          <p className="mt-2 text-xs text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className={BTN}
            onClick={onCancel}
            disabled={busy}
            data-appmcp-hint="Cancel the layout switch"
          >
            {t("cancel")}
          </button>
          <ActionButton
            type="submit"
            className={BTN_PRIMARY}
            busy={busy}
            busyLabel={t("starting")}
            disabled={!password}
            data-appmcp-hint={`Confirm the layout switch for ${label}`}
          >
            <SubmitLabel>{t("confirm.start")}</SubmitLabel>
          </ActionButton>
        </div>
      </CredentialForm>
    </div>
  );
}
