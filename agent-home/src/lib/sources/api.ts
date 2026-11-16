/**
 * Browser side of FG-03 P7 (Settings › Sources): BFF calls and the pure
 * helpers the Sources page, the register wizard and Recent routing share.
 */
import { getJson, sendJson } from "@/lib/admin-fetch";
import { withProfileQuery } from "@/lib/chat/profile";
import type {
  EmailMailbox,
  RoutingDecision,
  Source,
  SourceChannel,
  SourceClaimConflict,
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

/** The caller's resolved triage layers in `profile` (the BFF binds `?profile=`). */
export const triageLayers = (profile: string, channel: SourceChannel) =>
  getJson<TriageLayers>(withProfileQuery(`/api/triage/layers?kind=${triageKind(channel)}`, profile));

/** Save "What I care about" in the caller's own layer of `profile`. */
export const saveCare = (profile: string, channel: SourceChannel, content: string) =>
  sendJson<TriageCareWriteResult>(withProfileQuery("/api/triage/layers/care", profile), "PUT", {
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
  credential_ref: SourceInput["credential_ref"];
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Accounts from the existing mailbox / WhatsApp bridge / Telegram bot endpoints. */
export async function connectedAccounts(): Promise<Record<SourceChannel, ConnectedAccount[]>> {
  const [mail, wa, tg] = await Promise.all([
    safe(() => getJson<{ mailboxes: EmailMailbox[] }>("/api/email/mailboxes")),
    safe(() => getJson<WaBridgesResponse>("/api/wa-bridges")),
    safe(() => getJson<TelegramBotView>("/api/telegram-bot")),
  ]);
  const email: ConnectedAccount[] = (mail?.mailboxes ?? []).map((m) => ({
    channel: "email",
    address: m.address,
    display: null,
    detail: m.state === "working" ? "working" : m.state === "needs_attention" ? "attention" : "untested",
    credential_ref: { kind: "email-imap", name: m.address },
  }));
  const whatsapp: ConnectedAccount[] = (wa?.bridges ?? [])
    .filter((b) => b.paired && b.number)
    .map((b) => ({
      channel: "whatsapp",
      address: b.number as string,
      display: b.name,
      detail: b.status === "connected" ? "working" : "attention",
      credential_ref: { kind: "wa-bridge", name: b.name },
    }));
  const telegram: ConnectedAccount[] =
    tg?.configured && tg.bot_username
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
  return { email, whatsapp, telegram };
}

export type DecisionOutcome = "routed" | "stored" | "fallback";

/** Routed / Stored only / Fallback for one Recent-routing row. */
export function decisionOutcome(d: RoutingDecision): DecisionOutcome {
  if (d.fallback) return "fallback";
  return d.selected.length > 0 ? "routed" : "stored";
}

/** Same address in another form (e.g. `+852 6178 2290` vs `+85261782290`). */
export function sameAddress(channel: SourceChannel, a: string, b: string): boolean {
  const norm = (s: string) =>
    channel === "email" ? s.trim().toLowerCase() : channel === "whatsapp" ? s.replace(/[^\d*]/g, "") : s.trim().replace(/^@/, "").toLowerCase();
  return norm(a) === norm(b);
}
