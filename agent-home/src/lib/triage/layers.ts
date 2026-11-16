import type { TriageLayeredFile, TriageLayerKind } from "@/types";

export const TRIAGE_TABS: ReadonlyArray<{ kind: TriageLayerKind; label: string }> = [
  { kind: "email", label: "Email" },
  { kind: "whatsapp", label: "WhatsApp" },
  { kind: "telegram", label: "Telegram" },
  { kind: "calendar", label: "Calendar" },
];

export function isTriageTab(value: string | null | undefined): value is TriageLayerKind {
  return TRIAGE_TABS.some((t) => t.kind === value);
}

/** Matches Hermes' `MAX_CARE_BYTES`; the counter shows characters like the mockup. */
export const CARE_MAX_BYTES = 4 * 1024;
export const CARE_MAX_CHARS = 2000;
export const CARE_KEY = "what-i-care-about.md";

/** BFF url for a layered-triage call, bound to `profile`. */
export function triageUrl(path: string, profile: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params);
  if (profile && profile !== "default") q.set("profile", profile);
  const s = q.toString();
  return `/api/triage/layers${path}${s ? `?${s}` : ""}`;
}

export function fileName(key: string): string {
  return key.split("/").pop() ?? key;
}

export type LayerBadge = "mine" | "template" | "builtin" | "off";

export const BADGE_LABEL: Record<LayerBadge, string> = {
  mine: "Mine",
  template: "Template",
  builtin: "Built-in",
  off: "Off",
};

export function layerBadge(file: Pick<TriageLayeredFile, "layer" | "disabled">): LayerBadge {
  if (file.disabled || !file.layer) return "off";
  return file.layer === "user" ? "mine" : file.layer;
}

/** One line under a file's name: where its text comes from. */
export function layerNote(file: TriageLayeredFile, profile: string): string {
  const badge = layerBadge(file);
  if (badge === "off") {
    if (file.layers.user === "disabled") return "Turned off for you";
    if (file.layers.template === "disabled") return `Turned off in the ${profile} template`;
    return "Turned off";
  }
  if (badge === "mine") {
    return file.layers.template === "content" || file.layers.builtin === "content"
      ? "Your version replaces the template"
      : "Only yours: you added it";
  }
  return badge === "template" ? `From the ${profile} template` : "Aquarium default";
}

/** Off in the template with no text of mine: turning it on needs my own version first. */
export function offByTemplate(file: TriageLayeredFile): boolean {
  return file.disabled && file.layers.user !== "disabled" && file.layers.user !== "content";
}

/**
 * A new file of mine: a plain `<name>.md` (Hermes allows 1–3 segments; the
 * page only adds top-level ones). Returns the key, or an error for the hint.
 */
export function newFileKey(
  raw: string,
  existing: readonly string[],
): { key: string; error?: undefined } | { key?: undefined; error: string } {
  const name = raw.trim();
  if (!name) return { error: "Give the file a name." };
  const key = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(key) || key.length > 120) {
    return { error: "Use letters, numbers, dots, dashes or underscores, e.g. vip-senders.md." };
  }
  if (key === CARE_KEY) return { error: "That name is kept for “What I care about”." };
  if (existing.includes(key)) return { error: `${key} already exists. Open it and edit your version instead.` };
  return { key };
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
