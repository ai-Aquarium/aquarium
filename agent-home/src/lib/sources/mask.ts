/**
 * The one masked form of a WhatsApp number (FG-03 Sources): the first 2 and
 * last 2 digits, `+15550002001` → `+15••••••01`, the same as Hermes'
 * `wa_bridge_owners.mask_number`. Hermes already masks every number it sends
 * here; the API client masks again so nothing older or missed reaches a page.
 */
import type { RoutingDecision, Source, SourceChannel, SourceClaimConflict } from "@/types";

/** Always six, so the masked form doesn't give away how many digits are hidden. */
export const NUMBER_MASK = "••••••";

/** `+15550002001` → `+15••••••01`; an already-masked value is left as it is. */
export function maskWhatsAppNumber(value: string): string {
  if (/[•*]/.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  if (!digits) return value;
  if (digits.length <= 4) return `+${NUMBER_MASK}`;
  return `+${digits.slice(0, 2)}${NUMBER_MASK}${digits.slice(-2)}`;
}

/** Every phone-number-like run (7–15 digits, optional `+`) in `text`, masked. */
export function maskPhoneNumbers(text: string): string {
  return text.replace(/\+?\d{7,15}/g, (m) => maskWhatsAppNumber(m));
}

/** How a source address may be shown: WhatsApp masked, email / Telegram as they are. */
export function displayAddress(channel: SourceChannel, address: string): string {
  return channel === "whatsapp" ? maskWhatsAppNumber(address) : address;
}

export const maskSource = <T extends Pick<Source, "channel" | "address">>(s: T): T =>
  s.channel === "whatsapp" ? { ...s, address: maskWhatsAppNumber(s.address) } : s;

export const maskConflict = <T extends Pick<SourceClaimConflict, "channel" | "address" | "detail">>(c: T): T =>
  c.channel === "whatsapp"
    ? { ...c, address: maskWhatsAppNumber(c.address), detail: c.detail ? maskPhoneNumbers(c.detail) : c.detail }
    : c;

export const maskDecision = <T extends Pick<RoutingDecision, "channel" | "first_sender">>(d: T): T =>
  d.channel === "whatsapp" && d.first_sender ? { ...d, first_sender: maskPhoneNumbers(d.first_sender) } : d;

/** A routing decision's first sender as it may be shown: any WhatsApp number in it masked. */
export function displaySender(channel: SourceChannel, sender: string): string {
  return channel === "whatsapp" ? maskPhoneNumbers(sender) : sender;
}
