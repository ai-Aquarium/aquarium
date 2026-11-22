import type { ProjectTab } from "@/components/projects/tabs/types";

/**
 * The project page's sections (2026-11-22 redesign): Planning, Execution
 * and Log next to the docked project chat. On a phone the chat is a tab too.
 */
export const PROJECT_SECTIONS = ["planning", "execution", "log"] as const;

export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

/** Phone tabs: the chat first, then the three sections. */
export const PHONE_SECTIONS = ["chat", ...PROJECT_SECTIONS] as const;

export type PhoneSection = (typeof PHONE_SECTIONS)[number];

/** What each section shows, top to bottom (the older tabs, reused). */
export const SECTION_PARTS: Record<ProjectSection, readonly ProjectTab[]> = {
  planning: ["scope", "inputs", "plan", "outputs"],
  execution: ["dashboard", "board", "iterations"],
  log: [],
};

/** Skills and Settings moved into the header's ⋯ sheet. */
export const SHEET_PARTS = ["skills", "settings"] as const satisfies readonly ProjectTab[];

export type SheetPart = (typeof SHEET_PARTS)[number];

export interface TabTarget {
  section: PhoneSection;
  /** Scroll to this part inside the section (an old deep link). */
  part?: ProjectTab;
  /** Open the ⋯ sheet on this part. */
  sheet?: SheetPart;
}

export function isPhoneSection(value: string | null | undefined): value is PhoneSection {
  return (PHONE_SECTIONS as readonly string[]).includes(value ?? "");
}

/**
 * Where a `?tab=` value lands. New names pass through; the old tab and
 * group names map onto the section that now holds them, so bookmarks and
 * links in notifications keep working. Anything unknown opens Planning.
 */
export function resolveTabParam(value: string | null | undefined): TabTarget {
  const raw = (value ?? "").trim().toLowerCase();
  if (isPhoneSection(raw)) return { section: raw };
  switch (raw) {
    case "scope":
    case "brief":
    case "inputs":
    case "plan":
    case "playbook":
    case "outputs":
      return { section: "planning", part: raw === "brief" ? "scope" : raw === "playbook" ? "plan" : (raw as ProjectTab) };
    case "board":
    case "iterations":
    case "runs":
      return { section: "execution", part: raw === "runs" ? "iterations" : (raw as ProjectTab) };
    case "work":
    case "dashboard":
    case "overview":
      return { section: "execution" };
    case "files":
      return { section: "planning", part: "outputs" };
    case "skills":
    case "settings":
      return { section: "planning", sheet: raw };
    case "setup":
      return { section: "planning", part: "scope" };
    case "events":
    case "activity":
      return { section: "log" };
    default:
      // No tab, or anything unknown.
      return { section: "planning" };
  }
}

/**
 * The URL a project link should land on once the old `?view=` switch is
 * gone: the same path and query without `view` (Task mode was removed), or
 * `null` when there is nothing to strip.
 */
export function withoutViewParam(path: string, query: Record<string, string | string[] | undefined>): string | null {
  if (!("view" in query)) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "view" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
