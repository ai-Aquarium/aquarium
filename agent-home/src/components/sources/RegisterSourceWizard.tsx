"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { BTN_GHOST, BTN_PRIMARY, CARD, ChannelBadge, ProfileChip } from "@/components/sources/ui";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { CheckIcon, ChevronLeftIcon, PlusIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n/client";
import { AdminFetchError, errorText } from "@/lib/admin-fetch";
import {
  CHANNELS,
  CONNECT_HREF,
  connectedAccounts,
  putSourceRoute,
  registerSource,
  sameAddress,
  saveCare,
  telegramTriageOn,
  triageLayers,
  type ConnectedAccount,
  type SourcesList,
} from "@/lib/sources/api";
import type { SourceChannel } from "@/types";

const STEPS = ["channel", "profiles", "triage", "review"] as const;
const CARE_MAX = 2000;

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
  const [step, setStep] = useState(0);
  const [channel, setChannel] = useState<SourceChannel>("email");
  const [accounts, setAccounts] = useState<Record<SourceChannel, ConnectedAccount[]> | null>(null);
  const [account, setAccount] = useState<ConnectedAccount | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [care, setCare] = useState<Record<string, string>>({});
  const [careLoading, setCareLoading] = useState<Record<string, boolean>>({});
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    void connectedAccounts().then((a) => {
      if (live) setAccounts(a);
    });
    return () => {
      live = false;
    };
  }, []);

  const triage = channelHasTriage(channel, telegramOn);
  const isTaken = (a: ConnectedAccount) =>
    list.sources.some((s) => s.channel === a.channel && sameAddress(a.channel, s.address, a.address));

  const pickChannel = (c: SourceChannel) => {
    setChannel(c);
    setAccount(null);
    setCare({});
    setChoice({});
  };

  const customize = async (profile: string) => {
    setChoice((cur) => ({ ...cur, [profile]: "custom" }));
    if (care[profile] !== undefined) return;
    setCareLoading((cur) => ({ ...cur, [profile]: true }));
    try {
      const layers = await triageLayers(profile, channel);
      setCare((cur) => ({ ...cur, [profile]: cur[profile] ?? layers.care.content }));
    } catch {
      setCare((cur) => ({ ...cur, [profile]: cur[profile] ?? "" }));
    } finally {
      setCareLoading((cur) => ({ ...cur, [profile]: false }));
    }
  };

  const custom = triage ? picked.filter((p) => choice[p] === "custom") : [];
  const valid = [
    account !== null,
    picked.length > 0,
    custom.every((p) => (care[p] ?? "").trim().length > 0 && (care[p] ?? "").length <= CARE_MAX),
    conflict === null,
  ][step];

  const register = async () => {
    if (!account) return;
    setError(null);
    setSubmitting(true);
    try {
      let sourceId: string;
      try {
        const { source } = await registerSource({
          channel: account.channel,
          address: account.address,
          display: account.display,
          credential_ref: account.credential_ref,
        });
        sourceId = source.source_id;
      } catch (err) {
        if (err instanceof AdminFetchError && err.status === 409) {
          setConflict(t("wizard.conflict", { address: account.address }));
          return;
        }
        setError(errorText(err));
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
          ? { tone: "danger", text: t("wizard.partial", { address: account.address, detail: failed.join("; ") }) }
          : { tone: "success", text: t("wizard.done", { address: account.address }) },
      );
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const back = () => {
    setConflict(null);
    setError(null);
    if (step === 0) onClose();
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
          onClick={() => setStep(step + 1)}
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
          <div role="radiogroup" aria-label={t("wizard.step.channel")} className="grid grid-cols-3 gap-2">
            {CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={channel === c}
                data-channel={c}
                onClick={() => pickChannel(c)}
                className={`${CARD} flex flex-col items-start gap-1 p-3 text-left ${
                  channel === c ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : ""
                }`}
              >
                <ChannelBadge channel={c} />
                <span className="text-sm font-semibold">{t(`channel.${c}`)}</span>
                <span className="hidden text-xs text-[var(--color-muted)] sm:block">{t(`channelHint.${c}`)}</span>
              </button>
            ))}
          </div>
          <p className="text-sm font-medium">{t("wizard.accounts")}</p>
          {accounts === null ? (
            <p className="text-sm text-[var(--color-muted)]" role="status">{t("wizard.loadingAccounts")}</p>
          ) : (
            <div role="radiogroup" aria-label={t("wizard.accounts")} className="space-y-2">
              {accounts[channel].map((a) => {
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
                      <span className="block truncate text-sm font-semibold">{a.address}</span>
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
              {t("wizard.telegramOff", { address: account?.address ?? accounts?.telegram[0]?.address ?? "@bot" })}
            </InlineAlert>
          ) : null}
        </section>
      ) : null}

      {step === 1 ? (
        <section aria-labelledby="wiz-profiles" className="space-y-3">
          <StepHeading id="wiz-profiles" title={t("wizard.profilesTitle")} hint={t("wizard.profilesHint")} />
          {list.profiles.length === 0 ? (
            <div className={`${CARD} px-4 py-8 text-center`} data-testid="no-profiles">
              <p className="font-semibold">{t("wizard.noProfilesTitle")}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-muted)]">{t("wizard.noProfilesBody")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {list.profiles.map((p) => {
                const on = picked.includes(p);
                return (
                  <label key={p} className={`${CARD} flex cursor-pointer items-center gap-3 p-3 ${on ? "border-[var(--color-accent)]" : ""}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      data-profile={p}
                      onChange={() => setPicked((cur) => (on ? cur.filter((x) => x !== p) : [...cur, p]))}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span className="text-sm font-semibold">{p}</span>
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
                    label={t("wizard.useTemplate")}
                    hint={t("wizard.useTemplateHint")}
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
              {t(`channel.${account.channel}`)} · {account.address}
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
                    .map((p) => t(choice[p] === "custom" ? "wizard.review.custom" : "wizard.review.template", { profile: p }))
                    .join(" · ")
                : t("wizard.review.telegramOff")}
            </dd>
          </dl>
          {conflict ? (
            <InlineAlert tone="danger">{conflict}</InlineAlert>
          ) : error ? (
            <InlineAlert tone="danger">{error}</InlineAlert>
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
    <ol className="mb-4 flex items-center gap-2 text-xs" aria-label={t("wizard.stepOf", { n: step + 1 })}>
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
          <span className={`${i === step ? "text-[var(--color-fg)]" : "hidden text-[var(--color-muted)] sm:inline"}`}>
            {t(`wizard.step.${s}`)}
          </span>
          {i < STEPS.length - 1 ? <span aria-hidden className="h-px w-4 bg-[var(--color-border)] sm:w-6" /> : null}
        </li>
      ))}
    </ol>
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
