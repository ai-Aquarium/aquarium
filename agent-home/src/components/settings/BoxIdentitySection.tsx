"use client";

import { useRef, useState, type ChangeEvent } from "react";

import { BoxLogo } from "@/components/brand/BoxLogo";
import { useBranding } from "@/components/brand/BrandingProvider";
import { ActionButton } from "@/components/ui/ActionButton";
import { useT } from "@/i18n";
import {
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_LOGO_TYPES,
  BRANDING_NAME_MAX,
  brandName,
  isBrandingLogoType,
  monogramFor,
  parseBranding,
  type Branding,
} from "@/lib/branding/branding";

type Busy = "name" | "upload" | "reset" | null;

async function send(url: string, init: RequestInit): Promise<Branding> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : "");
  return parseBranding(body);
}

const button =
  "inline-flex items-center gap-2 rounded-[var(--radius-md)] px-3.5 py-2 text-sm font-medium disabled:opacity-50";
const primary = `${button} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`;
const secondary = `${button} border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg)]`;

/**
 * Settings → Name and logo (owner only): the entity name and logo the sign-in
 * page and top bar show (Figma "Box logo — mockup", `96:695`). Logo changes
 * save at once; the name saves with its button. With no logo the monogram
 * from the name is the default, and "Reset to default" returns to it.
 */
export function BoxIdentitySection() {
  const t = useT("settings");
  const tLogin = useT("login");
  const { branding, setBranding } = useBranding();
  const [name, setName] = useState(branding.name ?? "");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const draft: Branding = { name: name.trim() || null, logo: branding.logo };
  const monogram = monogramFor(draft.name);

  async function run(kind: Exclude<Busy, null>, url: string, init: RequestInit) {
    setBusy(kind);
    setError(null);
    setSaved(false);
    try {
      const next = await send(url, init);
      setBranding(next);
      if (kind === "name") {
        setName(next.name ?? "");
        setSaved(true);
      }
    } catch (err) {
      setError((err instanceof Error && err.message) || t("branding.failed"));
    } finally {
      setBusy(null);
    }
  }

  function saveName() {
    return run("name", "/api/settings/branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!isBrandingLogoType(file.type)) return setError(t("branding.badType"));
    if (file.size > BRANDING_LOGO_MAX_BYTES) return setError(t("branding.tooBig"));
    const form = new FormData();
    form.append("file", file);
    void run("upload", "/api/settings/branding/logo", { method: "PUT", body: form });
  }

  return (
    <div data-component="BoxIdentitySection" data-section="box-identity" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex min-w-0 flex-col gap-5 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 lg:p-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t("branding.title")}</h2>
            <p className="text-xs text-[var(--color-muted)]">{t("branding.hint")}</p>
          </div>
          <span className="shrink-0 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-0.5 text-xs text-[var(--color-muted)]">
            {t("branding.ownerOnly")}
          </span>
        </header>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="box-identity-name" className="text-sm font-medium">
            {t("branding.name")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="box-identity-name"
              type="text"
              value={name}
              maxLength={BRANDING_NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              placeholder="Aquarium"
              className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
            <ActionButton
              data-action="save-name"
              onAction={saveName}
              busy={busy === "name"}
              busyLabel={t("branding.saving")}
              disabled={busy !== null || name.trim() === (branding.name ?? "")}
              className={primary}
            >
              {t("branding.saveName")}
            </ActionButton>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            {saved ? t("branding.saved") : t("branding.nameHint")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("branding.logo")}</span>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex shrink-0 items-center justify-center self-start rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <BoxLogo size={88} branding={draft} />
            </div>
            <div className="flex min-w-0 flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span data-logo-state={branding.logo ? "custom" : "default"}>
                  {branding.logo ? t("branding.customLogo") : t("branding.defaultLogo")}
                </span>
                {branding.logo ? null : (
                  <span className="rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-0.5 text-xs text-[var(--color-muted)]">
                    {t("branding.noLogo")}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  data-action="upload-logo"
                  onAction={() => fileRef.current?.click()}
                  busy={busy === "upload"}
                  disabled={busy !== null}
                  className={primary}
                >
                  {branding.logo ? t("branding.replace") : t("branding.upload")}
                </ActionButton>
                <ActionButton
                  data-action="reset-logo"
                  onAction={() => run("reset", "/api/settings/branding/logo", { method: "DELETE" })}
                  busy={busy === "reset"}
                  disabled={busy !== null || !branding.logo}
                  className={secondary}
                >
                  {t("branding.reset")}
                </ActionButton>
                <input
                  ref={fileRef}
                  type="file"
                  accept={BRANDING_LOGO_TYPES.join(",")}
                  onChange={onFile}
                  className="hidden"
                  data-testid="logo-file"
                />
              </div>
              <p className="text-xs text-[var(--color-muted)]">{t("branding.logoHint")}</p>
            </div>
          </div>
        </div>

        <div data-component="monogram-fallback" className="flex items-center gap-3.5 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] px-3.5 py-3">
          <BoxLogo size={40} branding={{ name: draft.name, logo: null }} />
          <div className="min-w-0">
            {monogram ? (
              <>
                <p className="text-sm font-medium">{t("branding.fallbackTitle", { monogram })}</p>
                <p className="text-xs text-[var(--color-muted)]">{t("branding.fallbackHint", { name: draft.name ?? "" })}</p>
              </>
            ) : (
              <p className="text-xs text-[var(--color-muted)]">{t("branding.fallbackNone")}</p>
            )}
          </div>
        </div>

        {error ? (
          <p role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </section>

      <aside aria-label={t("branding.preview")} className="flex flex-col gap-3 self-start rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h3 className="text-sm font-semibold">{t("branding.preview")}</h3>
        <p className="text-xs text-[var(--color-muted)]">{t("branding.previewTopBar")}</p>
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5">
          <BoxLogo size={24} branding={draft} />
          <span className="truncate text-sm font-semibold">{brandName(draft)}</span>
        </div>
        <p className="text-xs text-[var(--color-muted)]">{t("branding.previewSignIn")}</p>
        <div className="flex flex-col gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <BoxLogo size={40} branding={draft} />
          <span className="text-base font-semibold">
            {draft.name ? tLogin("titleTo", { name: draft.name }) : tLogin("title")}
          </span>
        </div>
      </aside>
    </div>
  );
}
