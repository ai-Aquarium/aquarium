"use client";

import { useState } from "react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { useAction } from "@/lib/use-action";
import { SNOOZE_HOURS, snoozeUntil } from "@/lib/suggested-tasks/channels";
import type { SuggestedTask } from "@/types";

import { StartTaskSheet } from "./StartTaskSheet";
import { SuggestedTaskCard } from "./SuggestedTaskCard";
import { announceSuggestedTasksChanged } from "./useSuggestedTasks";

export async function post(path: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (res.ok) return null;
    const parsed = (await res.json().catch(() => null)) as { detail?: string } | null;
    return parsed?.detail ?? "That didn't go through.";
  } catch {
    return "Couldn't reach Aquarium. Try again.";
  }
}

/**
 * Suggested-task cards plus what their buttons open: the Start task sheet,
 * and Snooze / Dismiss with a one-line result. `onRemoved` lets the owner
 * drop the row before its re-read lands.
 */
export function SuggestedTaskList({
  tasks,
  compact = false,
  canStart = true,
  onRemoved,
  layout = "list",
  onDetails,
}: {
  tasks: SuggestedTask[];
  compact?: boolean;
  canStart?: boolean;
  onRemoved?: (todoId: string) => void;
  /** `grid`: up to three across on wide screens (Projects strip). */
  layout?: "list" | "grid";
  onDetails?: (task: SuggestedTask) => void;
}) {
  const [starting, setStarting] = useState<SuggestedTask | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const { run } = useAction(async (task: SuggestedTask, verb: "snooze" | "dismiss") => {
    const id = encodeURIComponent(task.todo.id);
    const label = task.todo.ref ?? task.todo.title;
    const error =
      verb === "snooze"
        ? await post(`/api/suggested-tasks/${id}/snooze`, { until: snoozeUntil().toISOString() })
        : await post(`/api/suggested-tasks/${id}/dismiss`);
    if (error) {
      setNotice({ tone: "danger", text: error });
      return;
    }
    setNotice({
      tone: "success",
      text: verb === "snooze" ? `Snoozed ${label} for ${SNOOZE_HOURS} hours.` : `Dismissed ${label}.`,
    });
    onRemoved?.(task.todo.id);
    announceSuggestedTasksChanged();
  });

  return (
    <div data-component="SuggestedTaskList" className="flex flex-col gap-2">
      {notice ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
      <div
        className={
          layout === "grid"
            ? "grid gap-2 md:grid-cols-2 xl:grid-cols-3"
            : "flex flex-col gap-2"
        }
      >
        {tasks.map((task) => (
          <SuggestedTaskCard
            key={task.todo.id}
            task={task}
            compact={compact}
            canStart={canStart}
            onWork={setStarting}
            onSnooze={(t) => run(t, "snooze")}
            onDismiss={(t) => run(t, "dismiss")}
            onDetails={onDetails}
          />
        ))}
      </div>
      {starting ? <StartTaskSheet task={starting} onClose={() => setStarting(null)} /> : null}
    </div>
  );
}
