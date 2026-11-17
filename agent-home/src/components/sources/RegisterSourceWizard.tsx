"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { NoProfilesCard } from "@/components/sources/NoProfilesCard";
import { BTN_GHOST, BTN_PRIMARY, CARD, ChannelBadge, ProfileChip } from "@/components/sources/ui";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { CheckIcon, ChevronLeftIcon, PlusIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n/client";
import { errorText } from "@/lib/admin-fetch";
import {
  accountsOf,
  canRouteTo,
  channelAccounts,
  CHANNELS,
  claimOwnerName,
  CONNECT_HREF,
  connectedAccounts,
  putSourceRoute,
  registerBody,
  registerErrorHint,
  registerSource,
  sameAccount,
  saveCare,
  telegramTriageOn,
  triageLayers,
  viewerOnly,
  type ChannelAccounts,
  type ConnectedAccount,
  type SourcesList,
} from "@/lib/sources/api";
import type { SourceChannel } from "@/types";
import { displayAddress } from "@/lib/sources/mask";

const STEPS = ["channel", "profiles", "triage", "review"] as const;
const CARE_MAX = 2000;
/** Hermes `write_care` limit (UTF-8 bytes). */
const CARE_MAX_BYTES = 4096;
const careBytes = (text: string) => new TextEncoder().encode(text).length;

type Choice = "template" | "custom";

/** Whether a channel has per-profile triage skills to choose (Telegram only once an admin turns it on). */
export function channelHasTriage(channel: SourceChannel, telegramOn: boolean): boolean {
  return channel !== "telegram" || telegramOn;
}

/**
 * Register-source wizard (FG-03 P7, Figma 1a–1h): Channel → Profiles →
 * Triage skills → Review. A dialog on desktop and a bottom sheet on phones
 * (`Sheet`). Register is one shot: `registerSource`, then `putSourceRoute`
 * per picked profile, then `saveTriageCare` for each customised profile.
 */
export function RegisterSourceWizard({
  list,
  onClose,
  onRegistered,
}: {
  list: SourcesList;
  onClose(): void;
  onRegistered(notice: { tone: "success" | "danger"; text: string }): void;
}) {
  const t = useT("sources");
  const telegramOn = telegramTriageOn(list);
  // Nobody to route to (no active enrolment anywhere): the Profiles step's
  // explanation is the whole story, so open there instead of on a channel
  // picker whose account reads would be refused anyway.
  // A viewer everywhere is the same story: nothing of theirs may read it.
  const noRoutable = viewerOnly(list);
  const noProfiles = list.profiles.length === 0 || noRoutable;
  const [step, setStep] = useState(noProfiles ? 1 : 0);
  const [channel, setChannel] = useState<SourceChannel>("email");
  const [accounts, setAccounts] = useState<Record<SourceChannel, ChannelAccounts> | null>(null);
  const [account, setAccount] = useState<ConnectedAccount | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [care, setCare] = useState<Record<string, string>>({});
  const [careLoading, setCareLoading] = useState<Record<string, boolean>>({});
  /** Profiles where I already have my own "What I care about" for this channel. */
  const [own, setOwn] = useState<Record<string, boolean>>({});
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The failure is fixed in the connect-account flow (e.g. pair the bridge first). */
  const [errorSetup, setErrorSetup] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (noProfiles) return;
    let live = true;
    void connectedAccounts().then((a) => {
      if (live) setAccounts(a);
    });
    return () => {
      live = false;
    };
  }, [noProfiles]);

  /** Re-read one failed channel; its button stays busy (one request) until the answer lands. */
  const retryAccounts = async (c: SourceChannel) => {
    const load = await channelAccounts(c);
    setAccounts((cur) => (cur ? { ...cur, [c]: load } : cur));
  };

  const triage = channelHasTriage(channel, telegramOn);
  const isTaken = (a: ConnectedAccount) =>
    list.sources.some((s) => sameAccount(a, s));

  const pickChannel = (c: SourceChannel) => {
    setChannel(c);
    setAccount(null);
    setCare({});
    setOwn({});
    setChoice({});
  };

  const loadCare = async (profile: string) => {
    if (care[profile] !== undefined || careLoading[profile]) return;
    setCareLoading((cur) => ({ ...cur, [profile]: true }));
    try {
      const layers = await triageLayers(profile, channel);
      setCare((cur) => ({ ...cur, [profile]: cur[profile] ?? layers.care.content }));
      setOwn((cur) => ({ ...cur, [profile]: layers.care.layer === "user" }));
    } catch {
      setCare((cur) => ({ ...cur, [profile]: cur[profile] ?? "" }));
    } finally {
      setCareLoading((cur) => ({ ...cur, [profile]: false }));
    }
  };

  const customize = (profile: string) => {
    setChoice((cur) => ({ ...cur, [profile]: "custom" }));
    void loadCare(profile);
  };

  const goNext = () => {
    if (step === 1 && triage) for (const p of picked) void loadCare(p);
    setStep(step + 1);
  };

  const custom = triage ? picked.filter((p) => choice[p] === "custom") : [];
  const valid = [
    account !== null,
    picked.length > 0,
    custom.every(
      (p) =>
        !careLoading[p] &&
        (care[p] ?? "").trim().length > 0 &&
        (care[p] ?? "").length <= CARE_MAX &&
        careBytes(care[p] ?? "") <= CARE_MAX_BYTES,
    ),
    conflict === null,
  ][step];

  const register = async () => {
    if (!account) return;
    setError(null);
    setSubmitting(true);
    try {
      let sourceId: string;
      let address = account.address;
      try {
        const { source } = await registerSource(registerBody(account));
        sourceId = source.source_id;
        address = displayAddress(account.channel, source.address || account.address);
      } catch (err) {
        const hint = registerErrorHint(err, account.channel);
        if (hint?.kind === "claim") {
          const owner = claimOwnerName(err);
          setConflict(
            owner
              ? t("wizard.conflictOwner", { address: displayAddress(account.channel, account.address), owner })
              : t("wizard.conflict", { address: displayAddress(account.channel, account.address) }),
          );
          return;
        }
        setError(hint ? t(hint.key) : errorText(err));
        setErrorSetup(hint?.setup ?? false);
        return;
      }
      const failed: string[] = [];
      for (const profile of picked) {
        try {
          await putSourceRoute(sourceId, profile, true);
        } catch (err) {
          failed.push(`${profile}: ${errorText(err)}`);
        }
      }
      for (const profile of custom) {
        try {
          await saveCare(profile, account.channel, care[profile]);
        } catch (err) {
          failed.push(`${profile}: ${errorText(err)}`);
        }
      }
      onRegistered(
        failed.length
          ? { tone: "danger", text: t("wizard.partial", { address, detail: failed.join("; ") }) }
          : { tone: "success", text: t("wizard.done", { address }) },
      );
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const back = () => {
    setConflict(null);
    setError(null);
    if (step === 0 || (noProfiles && step === 1)) onClose();
    else setStep(step - 1);
  };

  const footer = (
    <div className="flex w-full items-center gap-2" data-step={STEPS[step]}>
      <button type="button" data-action="wizard-back" className={BTN_GHOST} onClick={back} disabled={submitting}>
        <ChevronLeftIcon size={16} />
        {t("wizard.back")}
      </button>
      <span className="flex-1" />
      {conflict ? (
        <>
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            {t("close")}
          </button>
          <Link href="/users" className={BTN_PRIMARY} data-action="ask-admin">
            {t("wizard.askAdmin")}
          </Link>
        </>
      ) : step < 3 ? (
        <button
          type="button"
          data-action="wizard-next"
          className={BTN_PRIMARY}
          disabled={!valid}
          onClick={goNext}
        >
          {t("wizard.next")}
        </button>
      ) : (
        <ActionButton
          data-action="wizard-register"
          className={BTN_PRIMARY}
          busy={submitting}
          busyLabel={t("wizard.registering")}
          onAction={register}
        >
          <PlusIcon size={16} />
          {t("wizard.registerBtn")}
        </ActionButton>
      )}
    </div>
  );

  return (
    <Sheet title={t("wizard.title")} onClose={submitting ? () => undefined : onClose} wide component="RegisterSourceWizard" footer={footer}>
      <Stepper step={step} />
      {step === 0 ? (
        <section aria-labelledby="wiz-channel" className="space-y-3">
          <StepHeading id="wiz-channel" title={t("wizard.channelTitle")} hint={t("wizard.channelHint")} />
          <div role="radiogroup" aria-label={t("wizard.step.channel")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={channel === c}
                data-channel={c}
                onClick={() => pickChannel(c)}
                className={`${CARD} flex items-center gap-3 p-3 text-left sm:flex-col sm:items-start sm:gap-1 ${
                  channel === c ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : ""
                }`}
              >
                <ChannelBadge channel={c} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{t(`channel.${c}`)}</span>
                  <span className="block text-xs text-[var(--color-muted)]">{t(`channelHint.${c}`)}</span>
                </span>
                <span className="sm:hidden">
                  <Radio on={channel === c} />
                </span>
              </button>
            ))}
          </div>
          <p className="text-sm font-medium">{t("wizard.accounts")}</p>
          {accounts === null ? (
            <p className="text-sm text-[var(--color-muted)]" role="status">{t("wizard.loadingAccounts")}</p>
          ) : (
            <div role="radiogroup" aria-label={t("wizard.accounts")} className="space-y-2">
              {accounts[channel].state === "failed" ? (
                <div data-testid="accounts-failed" data-channel={channel}>
                  <InlineAlert
                    tone="danger"
                    action={
                      <ActionButton
                        key={channel}
                        data-action="retry-accounts"
                        className={BTN_GHOST}
                        busyLabel={t("wizard.accountsRetrying")}
                        onAction={() => retryAccounts(channel)}
                      >
                        {t("wizard.accountsRetry")}
                      </ActionButton>
                    }
                  >
                    <span className="block font-semibold">{t(`wizard.accountsFailed.${channel}`)}</span>
                    <span className="block text-xs">{t("wizard.accountsFailedHint")}</span>
                  </InlineAlert>
                </div>
              ) : accountsOf(accounts[channel]).length === 0 ? (
                <p className="text-sm text-[var(--color-muted)]" data-testid="accounts-empty">
                  {t(`wizard.noAccounts.${channel}`)}
                </p>
              ) : null}
              {accountsOf(accounts[channel]).map((a) => {
                const taken = isTaken(a);
                const on = account?.address === a.address && account.channel === a.channel;
                return (
                  <button
                    key={a.address}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={taken}
                    data-account={a.address}
                    onClick={() => setAccount(a)}
                    className={`${CARD} flex w-full items-center gap-3 p-3 text-left disabled:opacity-60 ${
                      on ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : ""
                    }`}
                  >
                    <Radio on={on} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{displayAddress(a.channel, a.address)}</span>
                      <span className="block truncate text-xs text-[var(--color-muted)]">
                        {t(`wizard.accountMeta.${a.channel}`, { name: a.display ?? "" })}
                      </span>
                    </span>
                    <span className={`shrink-0 text-xs ${a.detail === "working" ? "text-[var(--color-success)]" : "text-[var(--color-muted)]"}`}>
                      {taken
                        ? t("wizard.alreadySource")
                        : `● ${t(a.detail === "working" ? "wizard.connected" : a.detail === "attention" ? "wizard.attention" : "wizard.untested")}`}
                    </span>
                  </button>
                );
              })}
              <Link
                href={CONNECT_HREF[channel]}
                data-action="connect-new"
                className={`${CARD} flex w-full items-center gap-3 p-3 text-left hover:bg-[var(--color-surface-2)]`}
              >
                <Radio on={false} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{t(`wizard.connectNew.${channel}`)}</span>
                  <span className="block text-xs text-[var(--color-muted)]">{t(`wizard.connectHint.${channel}`)}</span>
                </span>
              </Link>
            </div>
          )}
          <p className="text-xs text-[var(--color-muted)]">{t("wizard.onlyYours")}</p>
          {channel === "telegram" && !telegramOn ? (
            <InlineAlert tone="warn">
              {t("wizard.telegramOff", { address: account?.address ?? accountsOf(accounts?.telegram)[0]?.address ?? "@bot" })}
            </InlineAlert>
          ) : null}
        </section>
      ) : null}

      {step === 1 ? (
        <section aria-labelledby="wiz-profiles" className="space-y-3">
          <StepHeading id="wiz-profiles" title={t("wizard.profilesTitle")} hint={t("wizard.profilesHint")} />
          {noProfiles ? (
            <NoProfilesCard viewerOnly={noRoutable} />
          ) : (
            <div className="space-y-2">
              {list.profiles.map((p) => {
                const on = picked.includes(p);
                const role = list.profile_roles?.[p];
                const readOnly = !canRouteTo(list, p);
                const hintId = `wiz-profile-${p}-readonly`;
                return (
                  <label
                    key={p}
                    data-readonly={readOnly ? "true" : undefined}
                    className={`${CARD} flex items-center gap-3 p-3 ${
                      readOnly ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                    } ${on ? "border-[var(--color-accent)]" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={readOnly}
                      aria-describedby={readOnly ? hintId : undefined}
                      data-profile={p}
                      onChange={() => {
                        if (readOnly) return;
                        setPicked((cur) => (on ? cur.filter((x) => x !== p) : [...cur, p]));
                      }}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{p}</span>
                      {readOnly ? (
                        <span id={hintId} data-testid="profile-readonly" className="block text-xs text-[var(--color-muted)]">
                          {t("wizard.viewerReadOnly")}
                        </span>
                      ) : null}
                    </span>
                    {role ? (
                      <span
                        data-testid="profile-role"
                        className="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-fg)]"
                      >
                        {t(`wizard.role.${role}`)}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {step === 2 ? (
        <section aria-labelledby="wiz-triage" className="space-y-3">
          <StepHeading id="wiz-triage" title={t("wizard.triageTitle")} hint={t("wizard.triageHint")} />
          {!triage ? (
            <InlineAlert tone="warn">{t("wizard.telegramOffShort")}</InlineAlert>
          ) : (
            picked.map((p) => {
              const mode = choice[p] ?? "template";
              const text = care[p] ?? "";
              return (
                <fieldset key={p} className={`${CARD} space-y-2 p-3`} data-profile={p}>
                  <legend className="sr-only">{p}</legend>
                  <p className="text-sm font-semibold">{p}</p>
                  <ChoiceRow
                    name={`triage-${p}`}
                    checked={mode === "template"}
                    label={own[p] ? t("wizard.keepMine") : t("wizard.useTemplate")}
                    hint={own[p] ? t("wizard.keepMineHint", { profile: p, channel }) : t("wizard.useTemplateHint")}
                    onPick={() => setChoice((cur) => ({ ...cur, [p]: "template" }))}
                  />
                  <ChoiceRow
                    name={`triage-${p}`}
                    checked={mode === "custom"}
                    label={t("wizard.customize")}
                    hint={t("wizard.customizeHint")}
                    onPick={() => void customize(p)}
                  />
                  {mode === "custom" ? (
                    careLoading[p] ? (
                      <p className="text-xs text-[var(--color-muted)]" role="status">{t("wizard.careLoading")}</p>
                    ) : (
                      <label className="block space-y-1">
                        <span className="text-sm font-medium">{t("wizard.care")}</span>
                        <textarea
                          value={text}
                          maxLength={CARE_MAX}
                          rows={3}
                          data-care={p}
                          onChange={(e) => setCare((cur) => ({ ...cur, [p]: e.target.value }))}
                          className="w-full rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg)] p-2 text-sm"
                        />
                        <span className="block text-xs text-[var(--color-muted)]">
                          {t("wizard.careHint", { profile: p, count: text.length })}
                        </span>
                        {careBytes(text) > CARE_MAX_BYTES ? (
                          <span className="block text-xs text-[var(--color-danger)]" role="alert">
                            {t("wizard.careTooLong", { bytes: careBytes(text) })}
                          </span>
                        ) : null}
                        <span className="block text-xs text-[var(--color-muted)]">{t("wizard.careLater")}</span>
                      </label>
                    )
                  ) : null}
                </fieldset>
              );
            })
          )}
        </section>
      ) : null}

      {step === 3 && account ? (
        <section aria-labelledby="wiz-review" className="space-y-3">
          <StepHeading id="wiz-review" title={t("wizard.reviewTitle")} hint={t("wizard.reviewHint")} />
          <dl className={`${CARD} grid grid-cols-[7rem_1fr] gap-x-3 gap-y-3 p-3 text-sm`}>
            <dt className="text-[var(--color-muted)]">{t("wizard.review.channel")}</dt>
            <dd>
              {t(`channel.${account.channel}`)} · {displayAddress(account.channel, account.address)}
            </dd>
            <dt className="text-[var(--color-muted)]">{t("wizard.review.profiles")}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {picked.map((p) => (
                <ProfileChip key={p} on>
                  {p}
                </ProfileChip>
              ))}
            </dd>
            <dt className="text-[var(--color-muted)]">{t("wizard.review.triage")}</dt>
            <dd>
              {triage
                ? picked
                    .map((p) =>
                      t(
                        choice[p] === "custom"
                          ? "wizard.review.custom"
                          : own[p]
                            ? "wizard.review.kept"
                            : "wizard.review.template",
                        { profile: p },
                      ),
                    )
                    .join(" · ")
                : t("wizard.review.telegramOff")}
            </dd>
          </dl>
          {conflict ? (
            <InlineAlert tone="danger">{conflict}</InlineAlert>
          ) : error ? (
            <InlineAlert tone="danger">
              <span data-testid="register-error">{error}</span>
              {errorSetup ? (
                <>
                  {" "}
                  <Link href={CONNECT_HREF[account.channel]} className="font-semibold underline" data-action="open-setup">
                    {t("wizard.err.openSetup")}
                  </Link>
                </>
              ) : null}
            </InlineAlert>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">{t("wizard.reviewNote")}</p>
          )}
        </section>
      ) : null}
    </Sheet>
  );
}

function Stepper({ step }: { step: number }) {
  const t = useT("sources");
  return (
    <>
    <div className="mb-4 sm:hidden" data-testid="stepper-phone">
      <p className="text-xs text-[var(--color-muted)]">
        {t("wizard.stepOf", { n: step + 1 })} · {t(`wizard.step.${STEPS[step]}`)}
      </p>
      <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1 rounded-full ${
              i < step
                ? "bg-[var(--color-success)]"
                : i === step
                  ? "bg-[var(--color-accent)]"
                  : "bg-[var(--color-surface-2)]"
            }`}
          />
        ))}
      </div>
    </div>
    <ol className="mb-4 hidden items-center gap-2 text-xs sm:flex" aria-label={t("wizard.stepOf", { n: step + 1 })}>
      {STEPS.map((s, i) => (
        <li key={s} className="flex min-w-0 items-center gap-2" aria-current={i === step ? "step" : undefined}>
          <span
            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
              i < step
                ? "bg-[var(--color-success)] text-white"
                : i === step
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
            }`}
          >
            {i < step ? <CheckIcon size={12} /> : i + 1}
          </span>
          <span className={i === step ? "text-[var(--color-fg)]" : "text-[var(--color-muted)]"}>
            {t(`wizard.step.${s}`)}
          </span>
          {i < STEPS.length - 1 ? <span aria-hidden className="h-px w-4 bg-[var(--color-border)] sm:w-6" /> : null}
        </li>
      ))}
    </ol>
    </>
  );
}

function StepHeading({ id, title, hint }: { id: string; title: string; hint: string }) {
  return (
    <div>
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      <p className="text-xs text-[var(--color-muted)]">{hint}</p>
    </div>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
        on ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
      }`}
    >
      {on ? <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" /> : null}
    </span>
  );
}

function ChoiceRow({
  name,
  checked,
  label,
  hint,
  onPick,
}: {
  name: string;
  checked: boolean;
  label: string;
  hint: string;
  onPick(): void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="radio" name={name} checked={checked} onChange={onPick} className="mt-1 accent-[var(--color-accent)]" />
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-[var(--color-muted)]">{hint}</span>
      </span>
    </label>
  );
}
