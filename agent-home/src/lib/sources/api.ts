/**
 * Browser side of FG-03 P7 (Settings › Sources): BFF calls and the pure
 * helpers the Sources page, the register wizard and Recent routing share.
 */
import { AdminFetchError, getJson, sendJson } from "@/lib/admin-fetch";
import { maskWhatsAppNumber } from "@/lib/sources/mask";
import type {
  EmailMailbox,
  Role,
  RoutingDecision,
  Source,
  SourceChannel,
  SourceClaimConflict,
  SourceCredentialRef,
  SourceInput,
  SourceRoute,
  SourceUpdate,
  TelegramBotView,
  TriageCareWriteResult,
  TriageLayers,
  WaBridgesResponse,
} from "@/types";

export interface SourcesList {
  sources: Source[];
  profiles: string[];
  /** The caller's own role in each of `profiles`; absent on an older Hermes. */
  profile_roles?: Record<string, Role>;
  is_box_admin: boolean;
  /** `triage.agent.telegram` when the API reports it; absent means off (the default). */
  telegram_triage?: "off" | "agent";
}

/** Telegram triage stays off until an admin sets `triage.agent.telegram: agent`. */
export function telegramTriageOn(list: Pick<SourcesList, "telegram_triage">): boolean {
  return list.telegram_triage === "agent";
}

export const CHANNELS: SourceChannel[] = ["email", "whatsapp", "telegram"];

export const CHANNEL_BADGE: Record<SourceChannel, string> = { email: "@", whatsapp: "WA", telegram: "TG" };

/** Where each channel's accounts are connected (the existing Settings flows). */
export const CONNECT_HREF: Record<SourceChannel, string> = {
  email: "/settings/in-out",
  whatsapp: "/settings/in-out",
  telegram: "/settings/in-out",
};

export const listSources = () => getJson<SourcesList>("/api/sources");
export const listConflicts = (all = false) =>
  getJson<{ conflicts: SourceClaimConflict[] }>(`/api/sources/conflicts${all ? "?all=1" : ""}`);
export const registerSource = (body: SourceInput) => sendJson<{ source: Source }>("/api/sources", "POST", body);
export const putSourceRoute = (sourceId: string, profile: string, enabled: boolean) =>
  sendJson<{ route: SourceRoute }>(
    `/api/sources/${encodeURIComponent(sourceId)}/routes/${encodeURIComponent(profile)}`,
    "PUT",
    { enabled },
  );
export const updateSource = (sourceId: string, body: SourceUpdate) =>
  sendJson<{ source: Source }>(`/api/sources/${encodeURIComponent(sourceId)}`, "PATCH", body);
export const deleteSource = (sourceId: string) =>
  sendJson<{ deleted: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}`, "DELETE");
export const resolveConflict = (conflictId: number, action: "keep" | "transfer") =>
  sendJson<{ conflict: SourceClaimConflict }>(`/api/sources/conflicts/${conflictId}/resolve`, "POST", { action });
export const sourceDecisions = (sourceId: string, limit = 50) =>
  getJson<{ decisions: RoutingDecision[] }>(
    `/api/sources/decisions?${new URLSearchParams({ source_id: sourceId, limit: String(limit) })}`,
  );

/** Triage skills kind for a channel (`/api/triage/layers?kind=`). */
export function triageKind(channel: SourceChannel): string {
  return channel;
}

/** Always name the profile, `default` too: the BFF would otherwise use the session's. */
const inProfile = (path: string, profile: string) =>
  `${path}${path.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile)}`;

/** The caller's resolved triage layers in `profile` (the BFF binds `?profile=`). */
export const triageLayers = (profile: string, channel: SourceChannel) =>
  getJson<TriageLayers>(inProfile(`/api/triage/layers?kind=${triageKind(channel)}`, profile));

/** Save "What I care about" in the caller's own layer of `profile`. */
export const saveCare = (profile: string, channel: SourceChannel, content: string) =>
  sendJson<TriageCareWriteResult>(inProfile("/api/triage/layers/care", profile), "PUT", {
    kind: triageKind(channel),
    layer: "user",
    content,
  });

/** One of the caller's already-connected accounts a source can be made from. */
export interface ConnectedAccount {
  channel: SourceChannel;
  address: string;
  display: string | null;
  /** Plain-words state, e.g. "checked 2 min ago". */
  detail: "working" | "attention" | "untested";
  credential_ref: SourceCredentialRef;
}

const emailAccounts = async (): Promise<ConnectedAccount[]> => {
  const mail = await getJson<{ mailboxes: EmailMailbox[] }>("/api/email/mailboxes");
  return (mail?.mailboxes ?? []).map((m) => ({
    channel: "email",
    address: m.address,
    display: null,
    detail: m.state === "working" ? "working" : m.state === "needs_attention" ? "attention" : "untested",
    credential_ref: { kind: "email-imap", name: m.address },
  }));
};

const whatsappAccounts = async (): Promise<ConnectedAccount[]> => {
  const wa = await getJson<WaBridgesResponse>("/api/wa-bridges");
  return (wa?.bridges ?? [])
    .filter((b) => b.paired && b.number)
    .map((b) => ({
      channel: "whatsapp",
      address: maskWhatsAppNumber(b.number as string),
      display: b.name,
      detail: b.status === "connected" ? "working" : "attention",
      credential_ref: { kind: "wa-bridge", bridge: b.name },
    }));
};

const telegramAccounts = async (): Promise<ConnectedAccount[]> => {
  const tg = await getJson<TelegramBotView>("/api/telegram-bot");
  return tg?.configured && tg.bot_username
    ? [
        {
          channel: "telegram",
          address: `@${tg.bot_username.replace(/^@/, "")}`,
          display: tg.bot_name ?? null,
          detail: tg.last_test_ok === false ? "attention" : tg.last_test_ok ? "working" : "untested",
          credential_ref: { kind: "telegram-bot" },
        },
      ]
    : [];
};

const ACCOUNT_LOADERS: Record<SourceChannel, () => Promise<ConnectedAccount[]>> = {
  email: emailAccounts,
  whatsapp: whatsappAccounts,
  telegram: telegramAccounts,
};

/**
 * One channel's connected accounts, or why they couldn't be read. A failed
 * endpoint (e.g. a 503) is `failed`, never an empty list: "no accounts yet"
 * and "couldn't check" need different next steps.
 */
export type ChannelAccounts =
  | { state: "ok"; accounts: ConnectedAccount[] }
  | { state: "failed"; status: number | null; detail: string };

/** Read one channel's accounts from its existing endpoint (mailboxes / WhatsApp bridges / Telegram bot). */
export async function channelAccounts(channel: SourceChannel): Promise<ChannelAccounts> {
  try {
    return { state: "ok", accounts: await ACCOUNT_LOADERS[channel]() };
  } catch (err) {
    return {
      state: "failed",
      status: err instanceof AdminFetchError ? err.status : null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Every channel's accounts, each loaded (and failing) on its own. */
export async function connectedAccounts(): Promise<Record<SourceChannel, ChannelAccounts>> {
  const [email, whatsapp, telegram] = await Promise.all(CHANNELS.map((c) => channelAccounts(c)));
  return { email, whatsapp, telegram };
}

/** The accounts of a loaded channel (none while it failed). */
export const accountsOf = (load: ChannelAccounts | undefined): ConnectedAccount[] =>
  load?.state === "ok" ? load.accounts : [];

export type DecisionOutcome = "routed" | "stored" | "fallback";

/** Routed / Stored only / Fallback for one Recent-routing row. */
export function decisionOutcome(d: RoutingDecision): DecisionOutcome {
  if (d.fallback) return "fallback";
  return d.selected.length > 0 ? "routed" : "stored";
}

/** Same address in another form (e.g. `+852 6178 2290` vs `+85261782290`). */
/**
 * `POST /api/sources` body. WhatsApp / Telegram send only the credential ref:
 * the browser sees a masked number / `@username`, so Hermes derives the address.
 */
export function registerBody(account: ConnectedAccount): SourceInput {
  const ref = account.credential_ref;
  if (account.channel === "whatsapp" && ref.kind === "wa-bridge" && ref.bridge)
    return { channel: "whatsapp", display: account.display, credential_ref: { kind: "wa-bridge", bridge: ref.bridge } };
  if (account.channel === "telegram" && ref.kind === "telegram-bot")
    return { channel: "telegram", display: account.display, credential_ref: { kind: "telegram-bot" } };
  return { channel: account.channel, address: account.address, display: account.display, credential_ref: ref };
}

export type RegisterErrorHint =
  | { kind: "claim" }
  | { kind: "hint"; key: string; /** Fixable in the connect-account flow. */ setup: boolean };

/**
 * Plain-language hint for a failed `POST /api/sources` (Hermes `sources_api.register`):
 * 400 bad / mismatched ref, 403 someone else's bridge or bot, 404 unknown bridge or
 * no bot saved, 409 bridge not paired / bot unusable, or else a claim conflict.
 */
export function registerErrorHint(err: unknown, channel: SourceChannel): RegisterErrorHint | null {
  if (!(err instanceof AdminFetchError)) return null;
  const detail = err.message;
  switch (err.status) {
    case 400:
      return { kind: "hint", key: "wizard.err.badRef", setup: false };
    case 403:
      return { kind: "hint", key: `wizard.err.notYours.${channel}`, setup: false };
    case 404:
      return { kind: "hint", key: `wizard.err.missing.${channel}`, setup: true };
    case 409:
      if (/not linked to a phone/i.test(detail)) return { kind: "hint", key: "wizard.err.notLinked", setup: true };
      if (/no valid token/i.test(detail)) return { kind: "hint", key: "wizard.err.noToken", setup: true };
      if (/profile's own telegram bot/i.test(detail)) return { kind: "hint", key: "wizard.err.profileBot", setup: false };
      return { kind: "claim" };
    default:
      return null;
  }
}

/** The current owner's display name a refused claim (409) carries, if Hermes sent one. */
export function claimOwnerName(err: unknown): string | null {
  if (!(err instanceof AdminFetchError) || err.status !== 409) return null;
  const owner = (err.body as { owner_display?: unknown } | null | undefined)?.owner_display;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
}

/** Whether `account` is already registered as `source` (by credential for WhatsApp / Telegram). */
export function sameAccount(account: ConnectedAccount, source: Source): boolean {
  if (account.channel !== source.channel) return false;
  if (sameAddress(account.channel, source.address, account.address)) return true;
  const a = account.credential_ref;
  const s = source.credential_ref;
  if (account.channel === "email" || !a?.kind || !s || s.kind !== a.kind) return false;
  return account.channel === "telegram" || (!!a.bridge && (s.bridge ?? s.name) === a.bridge);
}

export function sameAddress(channel: SourceChannel, a: string, b: string): boolean {
  // Two masked WhatsApp numbers can share their first / last digits: compare by credential instead.
  if (channel === "whatsapp" && /[•*]/.test(a + b)) return false;
  const norm = (s: string) =>
    channel === "email" ? s.trim().toLowerCase() : channel === "whatsapp" ? s.replace(/\D/g, "") : s.trim().replace(/^@/, "").toLowerCase();
  return norm(a) === norm(b);
}
