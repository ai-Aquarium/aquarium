"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

import { RegisterSourceWizard } from "@/components/sources/RegisterSourceWizard";
import {
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  ChannelBadge,
  ProfileChip,
  Switch,
} from "@/components/sources/ui";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { TrashIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/Sheet";
import { useConfirm } from "@/components/ui/useConfirm";
import { useT } from "@/i18n/client";
import { errorText } from "@/lib/admin-fetch";
import {
  deleteSource,
  listConflicts,
  listSources,
  putSourceRoute,
  resolveConflict,
  telegramTriageOn,
  updateSource,
  type SourcesList,
} from "@/lib/sources/api";
import { useAction } from "@/lib/use-action";
import type { Source, SourceClaimConflict } from "@/types";

/** Settings › Sources (FG-03 P7, Figma 2a–2c): the caller's sources and their routes. */
export function SourcesView({
  initial,
  initialConflicts,
}: {
  initial: SourcesList;
  initialConflicts: SourceClaimConflict[];
}) {
  const t = useT("sources");
  const [list, setList] = useState(initial);
  const [conflicts, setConflicts] = useState(initialConflicts);
  const [editing, setEditing] = useState<Source | null>(null);
  const [claimsOpen, setClaimsOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname() ?? "/settings/sources";
  const registering = useSearchParams()?.get("register") === "1";
  const closeWizard = () => router.replace(pathname, { scroll: false });
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const { ask, dialog } = useConfirm();

  const reload = useCallback(async () => {
    const [next, claims] = await Promise.all([
      listSources(),
      listConflicts(list.is_box_admin).catch(() => ({ conflicts })),
    ]);
    setList(next);
    setConflicts(claims.conflicts ?? []);
  }, [conflicts, list.is_box_admin]);

  const replace = (source: Source) =>
    setList((cur) => ({
      ...cur,
      sources: cur.sources.map((s) => (s.source_id === source.source_id ? source : s)),
    }));

  const open = conflicts.filter((c) => !c.resolved_at);
  const tgOn = telegramTriageOn(list);

  return (
    <div data-component="SourcesView" className="space-y-4 pb-20 sm:pb-0">
      {notice ? (
        <InlineAlert tone={notice.tone} action={
          <button type="button" className={BTN_GHOST} onClick={() => setNotice(null)}>{t("close")}</button>
        }>
          {notice.text}
        </InlineAlert>
      ) : null}

      {open.length > 0 ? (
        <ClaimsBanner conflicts={open} isAdmin={list.is_box_admin} onOpen={() => setClaimsOpen(true)} />
      ) : null}

      {list.sources.length === 0 ? (
        <div className={`${CARD} px-4 py-8 text-center`} data-testid="sources-empty">
          <p className="font-semibold">{t("emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-muted)]">{t("emptyBody")}</p>
        </div>
      ) : (
        <section
          className="sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--color-border)] sm:bg-[var(--color-surface)]"
          aria-label={t("title")}
        >
          <header className="hidden flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2.5 text-xs text-[var(--color-muted)] sm:flex">
            <span>{t("count", { count: list.sources.length })}</span>
            <span>{t("readsIt")}</span>
          </header>
          <ul className="space-y-3 sm:space-y-0 sm:divide-y sm:divide-[var(--color-border)]">
            {list.sources.map((source) => (
              <SourceRow
                key={source.source_id}
                source={source}
                telegramOn={tgOn}
                onChanged={replace}
                onEdit={() => setEditing(source)}
                onError={(text) => setNotice({ tone: "danger", text })}
                onRemove={async () => {
                  const enabled = source.routes.filter((r) => r.enabled).map((r) => r.profile);
                  const ok = await ask({
                    title: t("removeTitle", { address: source.address }),
                    body: t("removeBody", { profiles: enabled.join(", ") || "—" }),
                    confirmLabel: t("removeConfirm"),
                    cancelLabel: t("cancel"),
                    tone: "danger",
                  });
                  if (!ok) return;
                  try {
                    await deleteSource(source.source_id);
                    setList((cur) => ({ ...cur, sources: cur.sources.filter((s) => s.source_id !== source.source_id) }));
                    setNotice({ tone: "success", text: t("removed", { address: source.address }) });
                  } catch (err) {
                    setNotice({ tone: "danger", text: errorText(err) });
                  }
                }}
              />
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-[var(--color-muted)]">{t("footer")}</p>

      {editing ? (
        <EditRoutesSheet
          source={editing}
          profiles={list.profiles}
          onClose={() => setEditing(null)}
          onSaved={(source) => {
            replace(source);
            setEditing(null);
          }}
        />
      ) : null}
      {claimsOpen ? (
        <ClaimsSheet
          conflicts={open}
          isAdmin={list.is_box_admin}
          onClose={() => setClaimsOpen(false)}
          onResolved={(c) => {
            setConflicts((cur) => cur.map((x) => (x.conflict_id === c.conflict_id ? c : x)));
            void reload().catch(() => undefined);
          }}
        />
      ) : null}
      {registering ? (
        <RegisterSourceWizard
          list={list}
          onClose={closeWizard}
          onRegistered={(text) => {
            setNotice(text);
            void reload().catch(() => undefined);
          }}
        />
      ) : null}
      {dialog}
    </div>
  );
}

/** Phone rows use accent text links (Figma 2a phone); desktop keeps the table's buttons. */
const PHONE_LINK = "inline-flex min-h-9 items-center text-sm font-medium text-[var(--color-accent)]";
// Literal strings: Tailwind only emits classes it can see in source.
const SM_GHOST =
  "sm:inline-flex sm:min-h-9 sm:items-center sm:justify-center sm:gap-1.5 sm:rounded-lg sm:px-2 sm:py-1.5 sm:text-sm sm:font-normal sm:text-[var(--color-muted)] sm:hover:text-[var(--color-fg)]";
const SM_SECONDARY =
  "sm:inline-flex sm:min-h-9 sm:items-center sm:justify-center sm:gap-2 sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--color-border)] sm:bg-[var(--color-surface)] sm:px-3 sm:py-1.5 sm:text-sm sm:font-medium sm:text-[var(--color-fg)] sm:hover:bg-[var(--color-surface-2)]";

function sourceMeta(t: ReturnType<typeof useT>, source: Source, telegramOn: boolean): string {
  if (source.channel === "telegram") return t(telegramOn ? "meta.telegram" : "meta.telegramOff");
  return t(`meta.${source.channel}`);
}

function SourceRow({
  source,
  telegramOn,
  onChanged,
  onEdit,
  onRemove,
  onError,
}: {
  source: Source;
  telegramOn: boolean;
  onChanged(source: Source): void;
  onEdit(): void;
  onRemove(): Promise<void>;
  onError(text: string): void;
}) {
  const t = useT("sources");
  const toggle = useAction(async () => {
    try {
      const { source: next } = await updateSource(source.source_id, { enabled: !source.enabled });
      onChanged(next);
    } catch (err) {
      onError(errorText(err));
    }
  });
  const remove = useAction(onRemove);
  const routingHref = `/settings/sources/${encodeURIComponent(source.source_id)}/routing`;

  return (
    <li
      data-component="SourceRow"
      data-source={source.source_id}
      data-enabled={source.enabled ? "true" : "false"}
      className={`${CARD} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:rounded-none sm:border-0 sm:bg-transparent sm:px-4 sm:py-3`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:w-64 sm:flex-none">
        <ChannelBadge channel={source.channel} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{source.address}</p>
          <p className="text-xs text-[var(--color-muted)]">{sourceMeta(t, source, telegramOn)}</p>
        </div>
        <div className="flex items-center gap-1 sm:hidden">
          <Switch
            on={source.enabled}
            busy={toggle.pending}
            label={t("toggleLabel", { address: source.address })}
            onToggle={() => void toggle.run()}
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" data-testid="route-chips">
        <span className="text-xs text-[var(--color-muted)] sm:hidden">{t("readsLabel")}</span>
        {source.routes.length === 0 ? (
          <span className="text-xs text-[var(--color-muted)]">{t("noRoutes")}</span>
        ) : (
          source.routes.map((r) => (
            <ProfileChip key={r.profile} on={r.enabled}>
              {r.enabled ? r.profile : t("paused", { profile: r.profile })}
            </ProfileChip>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:shrink-0 sm:justify-end sm:gap-1">
        <span className="hidden items-center sm:order-first sm:inline-flex">
          <Switch
            on={source.enabled}
            busy={toggle.pending}
            label={t("toggleLabel", { address: source.address })}
            onToggle={() => void toggle.run()}
          />
          <span className="w-14 text-sm text-[var(--color-muted)]">
            {toggle.pending ? "…" : t(source.enabled ? "on" : "off")}
          </span>
        </span>
        <Link href={routingHref} data-action="recent-routing" className={`${PHONE_LINK} order-2 sm:order-none ${SM_GHOST}`}>
          {t("recentRouting")}
        </Link>
        <button
          type="button"
          data-action="edit-routes"
          className={`${PHONE_LINK} order-1 sm:order-none ${SM_SECONDARY}`}
          onClick={onEdit}
        >
          {t("editRoutes")}
        </button>
        <button
          type="button"
          data-action="remove-source"
          className={`order-3 ml-auto inline-flex min-h-9 items-center gap-1.5 text-sm text-[var(--color-danger)] disabled:opacity-50 sm:order-none sm:ml-0 ${SM_GHOST}`}
          disabled={remove.pending}
          aria-busy={remove.pending}
          onClick={() => void remove.run()}
        >
          <span className="hidden sm:inline-flex"><TrashIcon size={16} /></span>
          {t("remove")}
        </button>
      </div>
    </li>
  );
}

function ClaimsBanner({
  conflicts,
  isAdmin,
  onOpen,
}: {
  conflicts: SourceClaimConflict[];
  isAdmin: boolean;
  onOpen(): void;
}) {
  const t = useT("sources");
  const first = conflicts[0];
  return (
    <div
      data-component="ClaimsBanner"
      role="status"
      className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-warn)]/60 bg-[var(--color-attention-bg)] px-4 py-3 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-[var(--color-warn-text)]">
          {conflicts.length === 1 ? t("claimBannerOne") : t("claimBannerMany", { count: conflicts.length })}
        </p>
        <p className="text-[var(--color-warn-text)]/90">
          {isAdmin && conflicts.length > 1
            ? t("claimBannerAdmin")
            : t("claimBannerBody", { claimant: first.claimant_user_id, address: first.address })}
        </p>
      </div>
      <button type="button" data-action="see-claims" className={BTN_SECONDARY} onClick={onOpen}>
        {t("seeClaims")}
      </button>
    </div>
  );
}

function ClaimsSheet({
  conflicts,
  isAdmin,
  onClose,
  onResolved,
}: {
  conflicts: SourceClaimConflict[];
  isAdmin: boolean;
  onClose(): void;
  onResolved(conflict: SourceClaimConflict): void;
}) {
  const t = useT("sources");
  // Snapshot on open so a settled claim stays listed with its outcome.
  const [shown] = useState(conflicts);
  const [done, setDone] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const settle = async (c: SourceClaimConflict, action: "keep" | "transfer") => {
    setError(null);
    try {
      const { conflict } = await resolveConflict(c.conflict_id, action);
      setDone((cur) => ({
        ...cur,
        [c.conflict_id]:
          action === "keep"
            ? t("resolvedKeep", { owner: c.existing_owner_user_id ?? "—" })
            : t("resolvedTransfer", { claimant: c.claimant_user_id }),
      }));
      onResolved(conflict);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Sheet
      title={t("claimsTitle")}
      onClose={onClose}
      component="ClaimsSheet"
      footer={
        <button type="button" className={`${BTN_SECONDARY} ml-auto`} onClick={onClose}>
          {t("close")}
        </button>
      }
    >
      <p className="mb-3 text-sm text-[var(--color-muted)]">{t("claimsIntro")}</p>
      {error ? <InlineAlert tone="danger" className="mb-3">{error}</InlineAlert> : null}
      {shown.length === 0 ? <p className="text-sm">{t("noClaims")}</p> : null}
      <ul className="space-y-2">
        {shown.map((c) => (
          <li key={c.conflict_id} className={`${CARD} p-3 text-sm`} data-conflict={c.conflict_id}>
            <p>
              {isAdmin
                ? t("claimLine", { claimant: c.claimant_user_id, address: c.address, owner: c.existing_owner_user_id ?? "—" })
                : t("claimMine", { claimant: c.claimant_user_id, address: c.address })}
            </p>
            {done[c.conflict_id] ? (
              <p className="mt-2 text-[var(--color-success)]">{done[c.conflict_id]}</p>
            ) : isAdmin ? (
              <ClaimActions onSettle={(action) => settle(c, action)} />
            ) : null}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/** Keep / Give: one lock for the pair so a claim can't be settled twice. */
function ClaimActions({ onSettle }: { onSettle(action: "keep" | "transfer"): Promise<void> }) {
  const t = useT("sources");
  const [which, setWhich] = useState<"keep" | "transfer" | null>(null);
  const { run, pending } = useAction(async (action: "keep" | "transfer") => {
    setWhich(action);
    try {
      await onSettle(action);
    } finally {
      setWhich(null);
    }
  });
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <button
        type="button"
        data-action="claim-keep"
        className={BTN_SECONDARY}
        disabled={pending}
        aria-busy={which === "keep"}
        onClick={() => void run("keep")}
      >
        {which === "keep" ? t("keeping") : t("keep")}
      </button>
      <button
        type="button"
        data-action="claim-transfer"
        className={BTN_PRIMARY}
        disabled={pending}
        aria-busy={which === "transfer"}
        onClick={() => void run("transfer")}
      >
        {which === "transfer" ? t("transferring") : t("transfer")}
      </button>
    </div>
  );
}

function EditRoutesSheet({
  source,
  profiles,
  onClose,
  onSaved,
}: {
  source: Source;
  profiles: string[];
  onClose(): void;
  onSaved(source: Source): void;
}) {
  const t = useT("sources");
  const names = Array.from(new Set([...profiles, ...source.routes.map((r) => r.profile)]));
  const initial = Object.fromEntries(
    names.map((p) => [p, source.routes.find((r) => r.profile === p)?.enabled ?? false]),
  );
  const [on, setOn] = useState<Record<string, boolean>>(initial);
  const [error, setError] = useState<string | null>(null);
  const changed = names.filter((p) => on[p] !== initial[p]);

  const save = async () => {
    setError(null);
    const routes = [...source.routes];
    try {
      for (const profile of changed) {
        const { route } = await putSourceRoute(source.source_id, profile, on[profile]);
        const i = routes.findIndex((r) => r.profile === profile);
        if (i >= 0) routes[i] = route;
        else routes.push(route);
      }
      onSaved({ ...source, routes });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Sheet
      title={t("editTitle")}
      onClose={onClose}
      component="EditRoutesSheet"
      footer={
        <div className="ml-auto flex gap-2">
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            {t("cancel")}
          </button>
          <ActionButton
            className={BTN_PRIMARY}
            data-action="save-routes"
            disabled={changed.length === 0}
            busyLabel={t("saving")}
            onAction={save}
          >
            {t("saveRoutes")}
          </ActionButton>
        </div>
      }
    >
      <p className="mb-3 text-sm text-[var(--color-muted)]">{t("editIntro", { address: source.address })}</p>
      {error ? <InlineAlert tone="danger" className="mb-3">{error}</InlineAlert> : null}
      <ul className="space-y-2">
        {names.map((p) => (
          <li key={p} className={`${CARD} flex items-center gap-3 px-3 py-2`}>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p}</span>
            <Switch on={on[p]} label={p} onToggle={() => setOn((cur) => ({ ...cur, [p]: !cur[p] }))} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-[var(--color-muted)]">{t("editHint")}</p>
    </Sheet>
  );
}
