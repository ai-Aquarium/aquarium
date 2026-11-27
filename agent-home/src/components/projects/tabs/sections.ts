import type { ProjectTab } from "@/components/projects/tabs/types";

/**
 * The project page's steps (2026-11-27 "less is more" redesign): one spine,
 * Requirements → Plan → Cards → Runs. That is the whole navigation — Log,
 * Skills and Settings hide behind ⋯; on a phone the chat is a fifth view.
 */
export const PROJECT_STEPS = ["requirements", "plan", "cards", "runs"] as const;

export type ProjectStep = (typeof PROJECT_STEPS)[number];

/** Anywhere the detail view can be: a step, or the phone's Chat view. */
export type ProjectView = ProjectStep | "chat";

/** What each step shows, top to bottom (the older tabs, reused). */
export const STEP_PARTS: Record<ProjectStep, readonly ProjectTab[]> = {
  requirements: ["reqdoc", "scope"],
  plan: ["plan"],
  cards: ["board"],
  runs: ["runs", "outputs"],
};

/** Skills, Settings and the Log live in the header's ⋯ sheet. */
export const SHEET_PARTS = ["skills", "settings", "log"] as const;

export type SheetPart = (typeof SHEET_PARTS)[number];

export interface TabTarget {
  view: ProjectView;
  /** Scroll to this part inside the step (an old deep link). */
  part?: ProjectTab;
  /** Open the ⋯ sheet on this part. */
  sheet?: SheetPart;
}

export function isProjectView(value: string | null | undefined): value is ProjectView {
  return (PROJECT_STEPS as readonly string[]).includes(value ?? "") || value === "chat";
}

/**
 * Where a `?tab=` value lands. New step names pass through; the old tab,
 * section and group names map onto the step that now holds them, so
 * bookmarks and links in notifications keep working. Anything unknown opens
 * Requirements.
 */
export function resolveTabParam(value: string | null | undefined): TabTarget {
  const raw = (value ?? "").trim().toLowerCase();
  if (isProjectView(raw)) return { view: raw };
  switch (raw) {
    case "scope":
    case "brief":
    case "inputs":
    case "reqdoc":
    case "setup":
      return {
        view: "requirements",
        part:
          raw === "brief" || raw === "setup"
            ? "scope"
            : raw === "inputs" || raw === "reqdoc"
              ? "reqdoc"
              : (raw as ProjectTab),
      };
    case "playbook":
      return { view: "plan" };
    case "board":
      return { view: "cards", part: "board" };
    case "iterations":
    case "dashboard":
      return { view: "runs" };
    case "outputs":
    case "files":
      return { view: "runs", part: "outputs" };
    case "planning":
      return { view: "requirements" };
    case "work":
    case "overview":
    case "execution":
      return { view: "runs" };
    case "skills":
    case "settings":
      return { view: "requirements", sheet: raw };
    case "log":
    case "events":
    case "activity":
      return { view: "requirements", sheet: "log" };
    default:
      // No tab, or anything unknown.
      return { view: "requirements" };
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
