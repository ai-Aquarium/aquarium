"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { projectHref, CHECK_IN_CHOICES } from "@/components/projects/task/viewMode";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { Sheet } from "@/components/ui/Sheet";
import { startRequestText } from "@/lib/suggested-tasks/channels";
import type { ProjectAutonomy, QuickTaskResponse, SuggestedTask } from "@/types";

import { ChannelTag } from "./ChannelTag";
import { announceSuggestedTasksChanged } from "./useSuggestedTasks";

/** A suggested task checks in at every step: nothing runs without the person. */
export const SUGGESTED_TASK_AUTONOMY: ProjectAutonomy = "manual";

/**
 * Work on this = Start task: Projects Task mode's Start task, prefilled from
 * the suggested to-do and its source message, in Manual ("Every step").
 * The server seeds the task with the whole source message, links the to-do
 * and the message, and closes the to-do when the task is done; a second
 * start of the same to-do opens the task it already became.
 */
export function StartTaskSheet({
  task,
  onClose,
}: {
  task: SuggestedTask;
  onClose: () => void;
}) {
  const router = useRouter();
  const prefill = startRequestText(task);
  const [text, setText] = useState(prefill);
  const start = useProjectAction<QuickTaskResponse>();
  const request = text.trim();
  const edited = request !== prefill.trim();
  const { todo, source, channel } = task;

  const submit = () => {
    if (!request || start.busy) return;
    void start.run("/api/projects/quick-task", {
      body: {
        from_todo: { id: todo.id },
        // Only the person's own wording: the server writes the brief from
        // the to-do and appends the source message either way.
        ...(edited ? { request } : {}),
        autonomy: SUGGESTED_TASK_AUTONOMY,
      },
      skipRefresh: true,
      onSuccess: (project) => {
        announceSuggestedTasksChanged();
        router.push(projectHref(project.slug));
      },
    });
  };

  return (
    <Sheet
      title="Start task"
      component="StartTaskSheet"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            data-action="start-suggested-task"
            disabled={!request || start.busy}
            onClick={submit}
            className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            {start.busy ? "Starting…" : "Start task"}
          </button>
        </div>
      }
    >
      <form
        data-component="StartTaskForm"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">What should the agent do?</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={6}
            className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-transparent p-2 text-sm"
          />
        </label>
        {source ? (
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Attached</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <ChannelTag channel={channel} />
              <span
                data-component="StartTaskAttachment"
                className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs [overflow-wrap:anywhere]"
              >
                Attached: {source.subject?.trim() || source.sender_name?.trim() || "Source message"}
              </span>
            </div>
          </div>
        ) : null}
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 font-medium">Check in</legend>
          <div className="flex flex-wrap gap-1.5">
            {[...CHECK_IN_CHOICES]
              .sort((a) => (a.autonomy === SUGGESTED_TASK_AUTONOMY ? -1 : 0))
              .map((choice) => {
                const on = choice.autonomy === SUGGESTED_TASK_AUTONOMY;
                return (
                  <span
                    key={choice.autonomy}
                    aria-current={on ? "true" : undefined}
                    data-autonomy={choice.autonomy}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      on
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 font-medium text-[var(--color-fg)]"
                        : "border-[var(--color-border)] text-[var(--color-muted)] opacity-60"
                    }`}
                  >
                    {on ? `${choice.label} (Manual)` : choice.label}
                  </span>
                );
              })}
          </div>
          <span className="text-xs text-[var(--color-muted)]">
            The agent asks you before every step. Nothing is sent without your approval.
          </span>
        </fieldset>
        {start.error ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {start.error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
