"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";

import { ChatPane } from "@/components/chat/ChatPane";
import {
  ProjectChatDock,
  useChatDock,
  useIsDesktop,
} from "@/components/projects/chat/ProjectChatDock";
import { ProjectLog } from "@/components/projects/log/ProjectLog";
import { ChevronDownIcon, MoreIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";

import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { EditBriefSheet } from "@/components/projects/EditBriefSheet";
import { ProjectCategoryTag } from "@/components/projects/categories/ProjectCategoryTag";
import { useProjectCategories } from "@/components/projects/categories/useProjectCategories";
import { ProjectLifecycleMenu } from "@/components/projects/ProjectLifecycleMenu";
import { ReadinessChecklist } from "@/components/projects/ReadinessChecklist";
import { JourneyBar } from "@/components/projects/dashboard/JourneyBar";
import { nextAction } from "@/components/projects/dashboard/nextAction";
import {
  extraFindings,
  isRunnable,
  readinessItems,
  type ReadinessItem,
} from "@/components/projects/readiness";
import { revealTarget } from "@/components/projects/revealTarget";
import { durationLabel, tokenCountLabel } from "@/components/projects/format";
import { SummariseSheet } from "@/components/projects/SummariseSheet";
import {
  CADENCE_GLYPH,
  CADENCE_LABEL,
  HEALTH_LABEL,
} from "@/components/projects/ProjectRow";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Pill, type Tone } from "@/components/ui/Pill";
import { useRefresh } from "@/components/ui/useRefresh";
import { useProjectEvents } from "@/components/projects/useProjectEvents";
import { ChangeRequestSheet } from "@/components/projects/changes/ChangeRequestSheet";
import { LiveStatusBar } from "@/components/projects/live/LiveStatusBar";
import { BoardTab } from "@/components/projects/tabs/BoardTab";
import { DashboardTab } from "@/components/projects/tabs/DashboardTab";
import { InputsTab } from "@/components/projects/tabs/InputsTab";
import { ScopeTab } from "@/components/projects/tabs/ScopeTab";
import { IterationsTab } from "@/components/projects/tabs/IterationsTab";
import { OutputsTab } from "@/components/projects/tabs/OutputsTab";
import { PlanTab } from "@/components/projects/tabs/PlanTab";
import { ProjectTabsNav } from "@/components/projects/tabs/ProjectTabsNav";
import {
  SECTION_PARTS,
  SHEET_PARTS,
  resolveTabParam,
  type PhoneSection,
  type SheetPart,
} from "@/components/projects/tabs/sections";
import { SettingsTab } from "@/components/projects/tabs/SettingsTab";
import { useProjectSkillCandidateCount } from "@/components/projects/skills/store";
import { SkillsTab } from "@/components/projects/tabs/SkillsTab";
import {
  PROJECT_TAB_LABEL,
  type ProjectTab,
  type ProjectTabProps,
} from "@/components/projects/tabs/types";
import type {
  ChatMessage,
  ProjectBoardView,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectDoctorDetail,
  ProjectHealth,
  ProjectPlaybookResponse,
  ProjectUsage,
  SessionSummary,
} from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

const HEALTH_TONE: Record<ProjectHealth, Tone> = {
  ok: "success",
  attention: "warning",
  stalled: "danger",
};

const TOOL_BTN =
  "rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-50";

const TAB_COMPONENT: Record<ProjectTab, ComponentType<ProjectTabProps>> = {
  dashboard: DashboardTab,
  scope: ScopeTab,
  board: BoardTab,
  outputs: OutputsTab,
  iterations: IterationsTab,
  inputs: InputsTab,
  plan: PlanTab,
  settings: SettingsTab,
  skills: SkillsTab,
};

/** What the docked project chat opens with (loaded by the page, like `/chat`). */
export interface ProjectChat {
  profile: string;
  storageEnabled: boolean;
  sessions: SessionSummary[];
  sessionId: string | null;
  messages: ChatMessage[];
}

/**
 * `/projects/[slug]` — the one place (§13): a slim header, then a sticky
 * journey bar (the one next button) over the live status bar, an
 * then Planning / Execution / Log (2026-11-22 redesign) with the project chat
 * docked on the right (a tab of its own on a phone). Skills and Settings live
 * in the ⋯ sheet; old `?tab=` links map onto the section that now holds them. Fan-out safe by construction — each separately-fetched resource
 * arrives as `| null` and its panel says "unavailable" instead of failing
 * the page (§16).
 */
export function ProjectDetailView({
  project,
  board,
  playbook,
  directives,
  doctor = null,
  callerUserId,
  isInstanceAdmin,
  initialTab,
  chat,
}: {
  project: ProjectDetail;
  board: ProjectBoardView | null;
  playbook: ProjectPlaybookResponse | null;
  directives: ProjectDirectivesResponse | null;
  /** Server-side findings the local checklist cannot see (§9.2). */
  doctor?: ProjectDoctorDetail | null;
  /** The signed-in principal's user id — the lifecycle gate (§13). */
  callerUserId: string;
  /** Box-wide owner/admin outranks the per-project matrix (§11). */
  isInstanceAdmin: boolean;
  /** From `?tab=`; see `resolveTabParam` (anything unknown opens Planning). */
  initialTab?: string;
  /** The docked chat's conversations; without it the dock says chat is unavailable. */
  chat?: ProjectChat;
}) {
  const timeLabel = useTimeLabel();
  const { refresh, refreshing } = useRefresh();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { categories } = useProjectCategories();
  const [summariseOpen, setSummariseOpen] = useState(false);

  const callerRole =
    project.members.find((member) => member.user_id === callerUserId)?.role ??
    null;
  const canLead =
    isInstanceAdmin ||
    project.owner_user_id === callerUserId ||
    callerRole === "lead";
  const canAct = canLead || callerRole === "member";

  const readiness = readinessItems(project, playbook);
  const runnable = isRunnable(readiness);
  const findings = extraFindings(doctor, readiness);

  // §12 live updates: a run promoted in the background becomes visible
  // without a manual reload — the poller refreshes when the event head
  // moves (E3).
  useProjectEvents(project.slug);

  const blockedCount =
    board?.columns
      .flatMap((column) => column.tasks)
      .filter((task) => task.status === "blocked").length ?? 0;

  const t = useT("projects");
  const [target] = useState(() => resolveTabParam(initialTab));
  const [section, setSection] = useState<PhoneSection>(target.section);
  const [sheet, setSheet] = useState<SheetPart | null>(target.sheet ?? null);
  const [sheetPart, setSheetPart] = useState<SheetPart>(
    target.sheet ?? "skills",
  );
  // The panels render on the server too; `section` on desktop is never "chat".
  const shown = section === "chat" ? "planning" : section;
  const writeTabParam = (value: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!value || value === "planning") url.searchParams.delete("tab");
    else url.searchParams.set("tab", value);
    window.history.replaceState(null, "", url.toString());
  };
  const scrollTo = (part: ProjectTab) => {
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() =>
      document
        .getElementById(`project-section-${part}`)
        ?.scrollIntoView({ block: "start" }),
    );
  };
  useEffect(() => {
    if (target.part) scrollTo(target.part);
  }, [target]);
  const [dock, dockDispatch] = useChatDock(callerUserId);
  // An old tab name (a readiness link, a dashboard card): open its section
  // and scroll to it, or open the ⋯ sheet on Skills / Settings.
  const selectTab = useCallback((next: ProjectTab) => {
    const to = resolveTabParam(next);
    if (to.sheet) {
      setSheetPart(to.sheet);
      setSheet(to.sheet);
      return;
    }
    setSection(to.section);
    writeTabParam(to.part ?? to.section);
    if (to.part) scrollTo(to.part);
  }, []);
  const selectSection = (next: PhoneSection) => {
    setSection(next);
    writeTabParam(next);
  };
  // Open the tab that fixes a readiness gap, then scroll to and ring its field.
  const reveal = useCallback(
    (item: ReadinessItem) => {
      if (item.tab) selectTab(item.tab);
      if (item.target) revealTarget(item.target);
    },
    [selectTab],
  );
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState<string | undefined>(undefined);
  const openChange = (initialText?: string) => {
    setChangeText(initialText);
    setChangeOpen(true);
  };

  const triageCount =
    board?.columns
      .flatMap((column) => column.tasks)
      .filter((task) => task.status === "triage").length ?? 0;
  const skillCandidates = useProjectSkillCandidateCount(project.slug);
  const tabBadges: Partial<Record<PhoneSection, number>> = {
    execution: blockedCount + triageCount,
    planning: project.clarify?.open_count ?? 0,
  };
  const needsYou = blockedCount + triageCount;
  const liveRun = project.runs.find(
    (run) => run.status === "running" || run.status === "waiting",
  );
  // A saved open/closed choice (this browser) wins over the live-run default.
  const [savedStatus, saveStatus] = usePersistentState<StatusPref>(
    STATUS_OPEN_KEY,
    null,
    parseStatusPref,
    String,
  );
  const statusOpen = savedStatus
    ? savedStatus === "open"
    : needsYou > 0 || Boolean(liveRun);
  const statusLine = [
    liveRun ? `Run ${liveRun.run_no} ${liveRun.status}` : project.status,
    needsYou === 1
      ? t("needsYouOne")
      : needsYou > 1
        ? t("needsYou", { count: needsYou })
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const tabProps: ProjectTabProps = {
    project,
    board,
    playbook,
    directives,
    doctor,
    callerUserId,
    canLead,
    readiness,
    runnable,
    onNavigate: selectTab,
    onChangeRequest: openChange,
  };
  const parts = SECTION_PARTS[shown];
  const action = nextAction(
    project,
    board,
    readiness,
    playbook,
    undefined,
    canLead,
  );

  const meta = [
    project.status,
    CADENCE_LABEL[project.cadence],
    project.schedule ?? undefined,
    project.next_run_at != null
      ? `next ${timeLabel(project.next_run_at, "day")}`
      : undefined,
    project.autonomy,
  ]
    .filter(Boolean)
    .join(" · ");

  const more = (
    <button
      type="button"
      data-action="project-more"
      onClick={() => {
        setSheetPart("skills");
        setSheet("skills");
      }}
      title={t("more.hint")}
      aria-label={t("more.aria")}
      className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
    >
      <MoreIcon />
      {skillCandidates > 0 ? (
        <span className="rounded-[var(--radius-full)] bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold text-[var(--color-accent-fg)]">
          {skillCandidates}
        </span>
      ) : null}
    </button>
  );
  const SheetSection = TAB_COMPONENT[sheetPart];
  // On a phone the Chat tab shows only the tab bar above the chat.
  const desktop = useIsDesktop();
  const phoneHide = section === "chat" ? "max-lg:hidden" : "";

  return (
    <div
      data-component="ProjectDetailView"
      data-active-section={section}
      data-dock={dock.mode}
      className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:gap-6"
    >
      <div
        data-component="ProjectMain"
        className={`flex min-w-0 flex-1 flex-col gap-4 ${dock.mode === "max" ? "lg:hidden" : ""}`}
      >
        <div className={`flex min-w-0 flex-col gap-4 ${phoneHide}`}>
          <BusyRegion
            busy={refreshing}
            label={refreshing ? "Talking to the agent…" : undefined}
          >
            <div className="flex flex-col gap-4">
              {/* ── Header ─────────────────────────────────────────────── */}
              <header
                id="project-header"
                data-component="ProjectHeader"
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="text-lg leading-none text-[var(--color-muted)]"
                  >
                    {CADENCE_GLYPH[project.cadence]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-muted)]">
                    {meta}
                  </span>
                  <Pill tone={HEALTH_TONE[project.health]}>
                    {HEALTH_LABEL[project.health]}
                  </Pill>
                  <ProjectLifecycleMenu
                    project={project}
                    callerUserId={callerUserId}
                    isInstanceAdmin={isInstanceAdmin}
                  />
                </div>
                <div className="mt-1 flex">
                  <ProjectCategoryTag
                    categories={categories}
                    categoryId={project.category_id}
                  />
                </div>

                {project.archived ? (
                  <p className="mt-2 text-sm text-[var(--color-muted)]">
                    This project is archived — restore it (⋯) to run it again.
                  </p>
                ) : null}
              </header>
            </div>
          </BusyRegion>

          {/* ── Status: the journey bar and live status; collapsible on a phone ── */}
          <aside
            data-component="ProjectStatus"
            aria-label={t("statusAria")}
            data-open={statusOpen ? "true" : "false"}
            className={`min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 lg:border-0 lg:bg-transparent lg:p-0`}
          >
            <button
              type="button"
              data-action="toggle-project-status"
              aria-expanded={statusOpen}
              onClick={() => saveStatus(statusOpen ? "closed" : "open")}
              className="flex min-h-11 w-full items-center gap-2 text-left lg:hidden"
            >
              <span className="text-sm font-semibold">{t("status")}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">
                {statusLine}
              </span>
              <ChevronDownIcon
                aria-hidden
                className={`h-4 w-4 shrink-0 text-[var(--color-muted)] transition-transform ${statusOpen ? "rotate-180" : ""}`}
              />
            </button>
            <div
              className={`flex flex-col gap-3 ${statusOpen ? "mt-2 lg:mt-0" : "max-lg:hidden"}`}
            >
              <div data-component="ProjectStickyBars">
                <JourneyBar
                  project={project}
                  action={action}
                  readiness={readiness}
                  canLead={canLead}
                  canAct={canAct}
                  onNavigate={selectTab}
                  onReveal={reveal}
                  onChangeRequest={openChange}
                />
              </div>
              <LiveStatusBar
                project={project}
                board={board}
                runnable={runnable}
                ownsNextStep={false}
              />
            </div>
          </aside>

          {/* ── Tools, About, readiness: below the journey bar ─────────── */}
          {!project.archived ||
          project.goal ||
          project.usage ||
          project.summary ? (
            <section
              data-component="ProjectDetails"
              aria-label="Project details"
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 [&>*:first-child]:mt-0"
            >
              {!project.archived ? (
                <div
                  data-component="ProjectToolbar"
                  role="toolbar"
                  aria-label="Project tools"
                  className="mt-2 flex flex-wrap gap-1.5"
                >
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    className={TOOL_BTN}
                  >
                    Add
                  </button>
                  {canLead ? (
                    <button
                      type="button"
                      onClick={() => setEditOpen(true)}
                      className={TOOL_BTN}
                    >
                      Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setSummariseOpen(true)}
                    className={TOOL_BTN}
                  >
                    {project.summary ? "Update summary" : "Summarise"}
                  </button>
                </div>
              ) : null}

              {project.goal || project.usage || project.summary ? (
                <details data-component="ProjectAbout" className="group mt-2">
                  <summary className="cursor-pointer select-none text-xs font-medium text-[var(--color-muted)]">
                    About
                  </summary>
                  {project.goal ? (
                    <p className="mt-1 text-sm text-[var(--color-muted)]">
                      {project.goal}
                    </p>
                  ) : null}
                  {project.usage ? (
                    <ProjectUsageLine usage={project.usage} />
                  ) : null}
                  {project.summary ? (
                    <div
                      data-component="ProjectSummary"
                      className="mt-2 rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                    >
                      <p className="italic">{project.summary}</p>
                      {project.summary_at != null ? (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          Summarised {timeLabel(project.summary_at, "ago")}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </details>
              ) : null}

              {!project.archived && !runnable ? (
                <details
                  data-component="ProjectReadinessDetails"
                  className="mt-2"
                >
                  <summary className="cursor-pointer select-none text-xs font-medium text-[var(--color-muted)]">
                    Before it can run ·{" "}
                    {readiness.filter((item) => item.ok).length} of{" "}
                    {readiness.length} ready
                  </summary>
                  <ReadinessChecklist
                    items={readiness}
                    findings={findings}
                    onItem={reveal}
                  />
                </details>
              ) : null}
            </section>
          ) : null}
        </div>
        <ProjectTabsNav
          active={section}
          onSelect={selectSection}
          badges={tabBadges}
          end={more}
        />

        <div
          data-component="ProjectTabPanel"
          role="tabpanel"
          data-active-tab={shown}
          className={`flex min-w-0 flex-col gap-6 ${phoneHide}`}
        >
          {shown === "log" ? (
            <ProjectLog project={project} />
          ) : (
            parts.map((part) => {
              const Section = TAB_COMPONENT[part];
              return (
                <section
                  key={part}
                  id={`project-section-${part}`}
                  data-section={part}
                  className="flex min-w-0 scroll-mt-20 flex-col gap-2"
                >
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                    {part === "scope" ? t("brief") : PROJECT_TAB_LABEL[part]}
                  </h2>
                  <Section {...tabProps} />
                </section>
              );
            })
          )}
        </div>
      </div>

      <ProjectChatDock
        state={dock}
        dispatch={dockDispatch}
        profile={chat?.profile ?? "default"}
        phoneOpen={section === "chat"}
      >
        {(onMessageCount) =>
          chat ? (
            <ChatPane
              compact={dock.mode !== "max"}
              initialSessions={chat.sessions}
              initialSessionId={chat.sessionId}
              initialMessages={chat.messages}
              storageEnabled={chat.storageEnabled}
              profile={chat.profile}
              hidden={desktop ? dock.mode === "min" : section !== "chat"}
              onMessageCount={onMessageCount}
            />
          ) : (
            <p className="p-3 text-sm text-[var(--color-muted)]">
              {t("dock.unavailable")}
            </p>
          )
        }
      </ProjectChatDock>

      {sheet ? (
        <Sheet
          title={t("more.title")}
          side
          wide
          component="ProjectMoreSheet"
          onClose={() => setSheet(null)}
        >
          <div
            role="tablist"
            aria-label={t("more.title")}
            className="mb-3 flex gap-1"
          >
            {SHEET_PARTS.map((part) => (
              <button
                key={part}
                type="button"
                role="tab"
                aria-selected={sheetPart === part}
                data-tab={part}
                onClick={() => setSheetPart(part)}
                className={`h-9 rounded-[var(--radius-md)] px-3 text-sm ${
                  sheetPart === part
                    ? "bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                }`}
              >
                {PROJECT_TAB_LABEL[part]}
              </button>
            ))}
          </div>
          <section
            id={`project-section-${sheetPart}`}
            data-section={sheetPart}
            className="flex min-w-0 flex-col gap-2"
          >
            <SheetSection {...tabProps} />
          </section>
        </Sheet>
      ) : null}

      {addOpen ? (
        <AddToProjectSheet
          onClose={() => {
            setAddOpen(false);
            refresh();
          }}
          fixedSlug={project.slug}
          fixedName={project.name}
        />
      ) : null}

      {summariseOpen ? (
        <SummariseSheet
          slug={project.slug}
          initial={project.summary ?? ""}
          onClose={() => {
            setSummariseOpen(false);
            refresh();
          }}
        />
      ) : null}

      {changeOpen ? (
        <ChangeRequestSheet
          project={project}
          playbook={playbook}
          directives={directives}
          initialText={changeText}
          onClose={() => {
            setChangeOpen(false);
            refresh();
          }}
        />
      ) : null}

      {editOpen ? (
        <EditBriefSheet
          project={project}
          onClose={() => {
            setEditOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * "Used so far: 1h 37m over 2 runs · 1.45M tokens" — the project's basic
 * cost at a glance. Tokens are what the model read and wrote; prompt text
 * re-read from the provider's cache is billed far cheaper, so it is shown
 * apart instead of inflating the total.
 */
export function ProjectUsageLine({ usage }: { usage: ProjectUsage }) {
  const runs = `${usage.runs} run${usage.runs === 1 ? "" : "s"}`;
  const tokens = usage.tokens;
  return (
    <p
      data-component="ProjectUsage"
      className="mt-1 text-xs text-[var(--color-muted)]"
    >
      <span className="font-medium text-[var(--color-fg)]">Used so far:</span>{" "}
      {usage.runs === 0
        ? "no runs yet"
        : `${durationLabel(usage.run_seconds)} over ${runs}`}
      {" · "}
      {tokens == null ? (
        "tokens not recorded"
      ) : (
        <span
          title={`${tokens.input_tokens.toLocaleString()} read, ${tokens.output_tokens.toLocaleString()} written, ${tokens.cache_read_tokens.toLocaleString()} re-read from cache, in ${tokens.calls.toLocaleString()} model calls`}
        >
          {tokenCountLabel(tokens.total)} tokens
          {tokens.total > 0
            ? ` (${tokenCountLabel(tokens.input_tokens)} read, ${tokenCountLabel(tokens.output_tokens)} written)`
            : ""}
          {tokens.cache_read_tokens > 0
            ? ` + ${tokenCountLabel(tokens.cache_read_tokens)} re-read from cache`
            : ""}
        </span>
      )}
    </p>
  );
}

type StatusPref = "open" | "closed" | null;

const STATUS_OPEN_KEY = "aquarium.projects.statusOpen";

function parseStatusPref(raw: string): StatusPref {
  return raw === "open" || raw === "closed" ? raw : null;
}
