/**
 * Strip internal ids (user UUIDs, a quoted `subject '…'`) from a refusal
 * before it is shown. Hermes keeps them out of its messages; this guards
 * an older Hermes or a sibling path that still names one.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function withoutInternalIds(text: string): string {
  return text
    .replace(/\bsubject\s+'[^']*'\s*/gi, "")
    .replace(/\bsubject\s+"[^"]*"\s*/gi, "")
    .replace(UUID, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}
