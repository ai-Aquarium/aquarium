import type { ProjectAutonomy, ViewDevice } from "@/types";

const PHONE_UA = /Mobi|Android.+Mobile|iPhone|iPod|Windows Phone/i;

/**
 * The device class a request comes from, decided on the server so the first
 * render already shows the right layout (no hydration flip).
 * `Sec-CH-UA-Mobile` wins when the browser sends it; otherwise the user agent.
 */
export function deviceFromHeaders(
  userAgent: string | null | undefined,
  chUaMobile?: string | null,
): ViewDevice {
  if (chUaMobile === "?1") return "phone";
  if (chUaMobile === "?0") return "desktop";
  return PHONE_UA.test(userAgent ?? "") ? "phone" : "desktop";
}

export interface CheckInChoice {
  autonomy: ProjectAutonomy;
  label: string;
}

/** The quick-start sheet's "Check in with me" picker, as the autonomy it sets. */
export const CHECK_IN_CHOICES: readonly CheckInChoice[] = [
  { autonomy: "supervised", label: "Before risky steps" },
  { autonomy: "autonomous", label: "Only at the end" },
  { autonomy: "manual", label: "Every step" },
];

export const DEFAULT_CHECK_IN: ProjectAutonomy = "supervised";

export function checkInLabel(autonomy: ProjectAutonomy): string {
  return CHECK_IN_CHOICES.find((c) => c.autonomy === autonomy)?.label ?? autonomy;
}

/** Every project, one-offs included, opens the one project page. */
export function projectHref(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}`;
}
