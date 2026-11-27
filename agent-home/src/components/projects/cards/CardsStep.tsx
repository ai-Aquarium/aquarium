"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  boardTasks,
  groupIntoLanes,
  type LaneKey,
} from "@/components/projects/board/model";
import { stepDeps } from "@/components/projects/cards/stepCards";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { ActionError } from "@/components/projects/ActionError";
import { useT } from "@/i18n";
import { Pill } from "@/components/ui/Pill";
import type { ProjectBoardTask, PlaybookStep } from "@/types";

/**
 * The Cards step (redesign, frames "Cards step (Kanban)" and "(Graph)"): a
 * Kanban⇄Graph workspace over the project board. Kanban folds the board's
 * eight stages into Ready / Running / Needs you / Done; Graph lays cards
 * out by their plan-step dependency level with arrows for `depends_on`.
 * Clicking a card opens the 300px detail panel on the right.
 *
 * Approximations vs the mockup (documented in the plan file): cards don't
 * carry per-card In:/Out: specs or input/output chips, so tiles and the
 * panel omit them; "Regenerate" asks the agent to re-draft the plan
 * (`POST /playbook/draft`); the approval row is read-only.
 */
export function CardsStep({
  project,
  board,
  playbook,
  canLead,
  onDiscussInChat,
}: ProjectTabProps) {
  const t = useT("projects");
  const action = useProjectAction();
  const regen = useProjectAction();
  const [view, setView] = useState<"kanban" | "graph">("kanban");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cardTitle, setCardTitle] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const tasks = useMemo(() => boardTasks(board), [board]);
  const lanes = useMemo(() => groupIntoLanes(tasks), [tasks]);
  const steps = useMemo(
    () => playbook?.active?.steps ?? [],
    [playbook],
  );
  const stepIndex = useMemo(
    () => new Map(steps.map((s, i) => [s.key, i])),
    [steps],
  );
  const stepOf = (task: ProjectBoardTask): PlaybookStep | null =>
    steps.find((s) => s.key === task.current_step_key) ?? null;

  const selected = tasks.find((tk) => tk.id === selectedId) ?? null;
  const canEdit = canLead && !project.archived;
  const latestRun = project.runs.length
    ? project.runs.reduce((a, b) => (b.run_no > a.run_no ? b : a))
    : null;

  async function addCard() {
    const title = draft.trim();
    if (!title) return;
    const result = await action.run(
      `/api/projects/${encodeURIComponent(project.slug)}/cards`,
      { method: "POST", body: { title } },
    );
    if (result?.ok) {
      setDraft("");
      setCardTitle(null);
    }
  }

  return (
    <div
      data-component="CardsStep"
      className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]"
    >
      <div className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{t("cardsStep.title")}</h2>
          <span
            role="tablist"
            aria-label={t("cardsStep.viewToggle")}
            className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] p-0.5"
          >
            {(["kanban", "graph"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                data-appmcp-hint={`Show the cards as a ${v}`}
                className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-semibold ${
                  view === v
                    ? "bg-[var(--color-surface-2)] text-[var(--color-fg)]"
                    : "text-[var(--color-muted)]"
                }`}
              >
                {t(`cardsStep.${v}`)}
              </button>
            ))}
          </span>
          <span className="text-xs text-[var(--color-muted)]">
            {playbook?.active ? `From Plan v${playbook.active.rev}` : ""}
            {latestRun ? ` · status from R${latestRun.run_no}` : ""}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                void regen.run(
                  `/api/projects/${encodeURIComponent(project.slug)}/playbook/draft`,
                  { method: "POST" },
                )
              }
              disabled={!canEdit || regen.busy}
              data-appmcp-hint="Ask the agent to re-draft the plan and its cards"
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {t("cardsStep.regenerate")}
            </button>
            <button
              type="button"
              onClick={() => setCardTitle((v) => (v === null ? "" : null))}
              disabled={!canEdit}
              data-appmcp-hint="Add a card by hand"
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {t("cardsStep.addCard")}
            </button>
          </span>
        </div>

        {cardTitle !== null ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addCard();
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("cardsStep.cardTitle")}
              data-appmcp-hint="Title for the new card"
              className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              disabled={action.busy || !draft.trim()}
              data-appmcp-hint="Create the card"
              className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {t("cardsStep.create")}
            </button>
          </form>
        ) : null}
        <ActionError
          action={action}
          className="text-xs text-[var(--color-danger)]"
        />
        <ActionError
          action={regen}
          className="text-xs text-[var(--color-danger)]"
        />

        {view === "kanban" ? (
          <Kanban
            lanes={lanes}
            stepIndex={stepIndex}
            selectedId={selectedId}
            onSelect={setSelectedId}
            t={t}
          />
        ) : (
          <Graph
            tasks={tasks}
            steps={steps}
            stepIndex={stepIndex}
            selectedId={selectedId}
            onSelect={setSelectedId}
            t={t}
          />
        )}
      </div>

      {selected ? (
        <CardPanel
          task={selected}
          step={stepOf(selected)}
          stepNo={
            selected.current_step_key != null
              ? (stepIndex.get(selected.current_step_key) ?? null)
              : null
          }
          planRev={playbook?.active?.rev ?? null}
          slug={project.slug}
          onClose={() => setSelectedId(null)}
          onAsk={() =>
            onDiscussInChat?.(
              `Card ${selected.ref ?? selected.id}: ${selected.title}`,
            )
          }
          t={t}
        />
      ) : null}
    </div>
  );
}

const LANE_ORDER: LaneKey[] = ["up_next", "working", "waiting", "done"];

function Kanban({
  lanes,
  stepIndex,
  selectedId,
  onSelect,
  t,
}: {
  lanes: Record<LaneKey, ProjectBoardTask[]>;
  stepIndex: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-4" data-testid="cards-kanban">
      {LANE_ORDER.map((lane) => (
        <div key={lane} className="flex min-w-0 flex-col gap-2">
          <p className="text-xs font-semibold">
            <span
              className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                lane === "done"
                  ? "bg-[var(--color-success)]"
                  : lane === "working"
                    ? "bg-[var(--color-accent)]"
                    : lane === "waiting"
                      ? "bg-[var(--color-warn)]"
                      : "bg-[var(--color-muted)]"
              }`}
            />
            {t(`cardsStep.${lane}`)} {lanes[lane].length}
          </p>
          {lanes[lane].length === 0 ? (
            <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-xs text-[var(--color-muted)]">
              {t("cardsStep.laneEmpty")}
            </p>
          ) : (
            lanes[lane].map((task) => (
              <CardTile
                key={task.id}
                task={task}
                stepNo={
                  task.current_step_key != null
                    ? (stepIndex.get(task.current_step_key) ?? null)
                    : null
                }
                selected={task.id === selectedId}
                onSelect={onSelect}
                t={t}
              />
            ))
          )}
        </div>
      ))}
    </div>
  );
}

function CardTile({
  task,
  stepNo,
  selected,
  onSelect,
  t,
}: {
  task: ProjectBoardTask;
  stepNo: number | null;
  selected: boolean;
  onSelect: (id: string) => void;
  t: (k: string) => string;
}) {
  const waiting = (task.pending_approvals?.length ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      data-card={task.id}
      data-appmcp-hint="Open this card's details"
      className={`flex min-w-0 flex-col gap-1 rounded-[var(--radius-md)] border px-3 py-2 text-left ${
        selected
          ? "border-[var(--color-accent)]"
          : waiting
            ? "border-[var(--color-warn)]"
            : "border-[var(--color-border)]"
      } bg-[var(--color-surface)]`}
    >
      <span className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        {stepNo != null ? stepNo + 1 : task.ref ?? ""}
        {waiting ? <Pill tone="warning">{t("cardsStep.approval")}</Pill> : null}
      </span>
      <span className="truncate text-sm font-medium">{task.title}</span>
      <span className="flex items-center gap-1.5 text-xs">
        {task.assignee ? <Pill tone="muted">{task.assignee}</Pill> : null}
        <Pill tone="muted">
          {task.assignment?.assigned_by === "manual"
            ? t("cardsStep.edited")
            : t("cardsStep.auto")}
        </Pill>
      </span>
    </button>
  );
}

/** Cards laid out left→right by plan-step dependency level, edges = depends_on. */
function Graph({
  tasks,
  steps,
  stepIndex,
  selectedId,
  onSelect,
  t,
}: {
  tasks: ProjectBoardTask[];
  steps: PlaybookStep[];
  stepIndex: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  t: (k: string) => string;
}) {
  const [zoom, setZoom] = useState(1);
  const W = 190;
  const H = 92;

  // Level of each step = longest dependency chain length.
  const levelOfStep = useMemo(() => {
    const deps = new Map(steps.map((s) => [s.key, stepDeps(s)]));
    const memo = new Map<string, number>();
    const level = (key: string, seen: Set<string>): number => {
      if (memo.has(key)) return memo.get(key)!;
      if (seen.has(key)) return 0;
      seen.add(key);
      const d = deps.get(key) ?? [];
      const lv =
        d.length === 0 ? 0 : 1 + Math.max(...d.map((p) => level(p, seen)));
      memo.set(key, lv);
      return lv;
    };
    for (const key of deps.keys()) level(key, new Set());
    return memo;
  }, [steps]);

  const { nodes, edges } = useMemo(() => {
    const byStep = new Map<string, ProjectBoardTask>();
    for (const task of tasks) {
      if (task.current_step_key) byStep.set(task.current_step_key, task);
    }
    const order = [...tasks].sort((a, b) => {
      const ai =
        a.current_step_key != null
          ? (stepIndex.get(a.current_step_key) ?? 999)
          : 999;
      const bi =
        b.current_step_key != null
          ? (stepIndex.get(b.current_step_key) ?? 999)
          : 999;
      return ai - bi;
    });
    const levelCount = new Map<number, number>();
    const nodes = order.map((task) => {
      const lv =
        task.current_step_key != null
          ? (levelOfStep.get(task.current_step_key) ?? 0)
          : 0;
      const y = levelCount.get(lv) ?? 0;
      levelCount.set(lv, y + 1);
      return { task, x: 20 + lv * W, y: 20 + y * H };
    });
    const pos = new Map(nodes.map((n) => [n.task.id, n]));
    const edges: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
    for (const task of tasks) {
      const step = steps.find((s) => s.key === task.current_step_key);
      if (!step) continue;
      for (const dep of stepDeps(step)) {
        const src = byStep.get(dep);
        const to = pos.get(task.id);
        const from = src ? pos.get(src.id) : null;
        if (from && to) edges.push({ from, to });
      }
    }
    return { nodes, edges };
  }, [tasks, steps, stepIndex, levelOfStep]);

  const height = Math.max(160, ...nodes.map((n) => n.y + H));
  const width = Math.max(320, ...nodes.map((n) => n.x + W));

  return (
    <div className="flex flex-col gap-2" data-testid="cards-graph">
      <div className="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <svg
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t("cardsStep.graph")}
        >
          {edges.map((e, i) => (
            <line
              key={i}
              x1={e.from.x + 150}
              y1={e.from.y + 34}
              x2={e.to.x}
              y2={e.to.y + 34}
              stroke="var(--color-muted)"
              strokeWidth="1.5"
              markerEnd="url(#arrow)"
            />
          ))}
          <defs>
            <marker
              id="arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8" fill="none" stroke="var(--color-muted)" strokeWidth="1.5" />
            </marker>
          </defs>
          {nodes.map(({ task, x, y }) => (
            <g
              key={task.id}
              transform={`translate(${x},${y})`}
              onClick={() => onSelect(task.id)}
              style={{ cursor: "pointer" }}
            >
              <rect
                width="150"
                height="68"
                rx="8"
                fill="var(--color-surface)"
                stroke={
                  task.id === selectedId
                    ? "var(--color-accent)"
                    : (task.pending_approvals?.length ?? 0) > 0
                      ? "var(--color-warn)"
                      : "var(--color-border)"
                }
                strokeWidth="1.5"
              />
              <circle
                cx="12"
                cy="14"
                r="5"
                fill={
                  laneDot(groupIntoLanes([task]))
                }
              />
              <text x="22" y="18" fontSize="10" fill="var(--color-muted)">
                {task.ref ?? ""}
              </text>
              <text x="12" y="40" fontSize="12" fontWeight="600" fill="var(--color-fg)">
                {task.title.length > 18 ? `${task.title.slice(0, 17)}…` : task.title}
              </text>
              <text x="12" y="58" fontSize="10" fill="var(--color-muted)">
                {task.assignee ?? ""}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
        {(["done", "working", "waiting", "up_next"] as const).map((l) => (
          <span key={l} className="flex items-center gap-1">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                l === "done"
                  ? "bg-[var(--color-success)]"
                  : l === "working"
                    ? "bg-[var(--color-accent)]"
                    : l === "waiting"
                      ? "bg-[var(--color-warn)]"
                      : "bg-[var(--color-muted)]"
              }`}
            />
            {t(`cardsStep.${l}`)}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
            aria-label="Zoom out"
            data-appmcp-hint="Zoom the graph out"
            className="rounded border border-[var(--color-border)] px-2 py-0.5"
          >
            −
          </button>
          <span className="w-9 text-center">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
            aria-label="Zoom in"
            data-appmcp-hint="Zoom the graph in"
            className="rounded border border-[var(--color-border)] px-2 py-0.5"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            data-appmcp-hint="Reset the graph zoom"
            className="rounded border border-[var(--color-border)] px-2 py-0.5"
          >
            Fit
          </button>
        </span>
      </div>
    </div>
  );
}

function laneDot(lanes: Record<LaneKey, ProjectBoardTask[]>): string {
  if (lanes.done.length) return "var(--color-success)";
  if (lanes.working.length) return "var(--color-accent)";
  if (lanes.waiting.length) return "var(--color-warn)";
  return "var(--color-muted)";
}

function CardPanel({
  task,
  step,
  stepNo,
  planRev,
  slug,
  onClose,
  onAsk,
  t,
}: {
  task: ProjectBoardTask;
  step: PlaybookStep | null;
  stepNo: number | null;
  planRev: number | null;
  slug: string;
  onClose(): void;
  onAsk(): void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const waiting = task.pending_approvals?.length ?? 0;
  return (
    <aside
      data-component="CardPanel"
      className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-[var(--color-muted)]">
          {t("cardsStep.cardMeta", {
            card: task.ref ?? task.id,
            plan: planRev != null ? `v${planRev}` : "—",
            step: stepNo != null ? `step ${stepNo + 1}` : "—",
          })}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          data-appmcp-hint="Close the card panel"
          className="text-[var(--color-muted)]"
        >
          ✕
        </button>
      </div>
      <h3 className="text-sm font-semibold">{task.title}</h3>
      <div className="flex flex-wrap gap-1.5">
        {waiting > 0 ? <Pill tone="warning">{t("cardsStep.needsApproval")}</Pill> : null}
        {task.assignment?.assigned_by === "manual" ? (
          <Pill tone="muted">{t("cardsStep.editedBy")}</Pill>
        ) : null}
      </div>
      {task.body ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            {t("cardsStep.instructions")}
          </h4>
          <p className="text-sm">{task.body}</p>
        </div>
      ) : null}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {t("cardsStep.profile")}
        </h4>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {task.assignee ? <Pill tone="muted">{task.assignee}</Pill> : null}
          {task.assignment?.assignee_reason ?? step?.assignee_reason ? (
            <span className="text-xs text-[var(--color-muted)]">
              {task.assignment?.assignee_reason ?? step?.assignee_reason}
            </span>
          ) : null}
        </p>
      </div>
      {waiting > 0 ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            {t("cardsStep.approval")}
          </h4>
          <p className="text-xs text-[var(--color-muted)]">
            {t("cardsStep.waitingApproval", { count: waiting })}
          </p>
        </div>
      ) : null}
      <div className="mt-auto flex items-center gap-2 border-t border-[var(--color-border)] pt-3">
        <Link
          href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(task.id)}`}
          data-appmcp-hint="Open the full card page"
          className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold"
        >
          {t("cardsStep.openCard")}
        </Link>
        <button
          type="button"
          onClick={onAsk}
          data-appmcp-hint="Ask the agent about this card"
          className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold"
        >
          {t("cardsStep.askAgent")}
        </button>
      </div>
    </aside>
  );
}
