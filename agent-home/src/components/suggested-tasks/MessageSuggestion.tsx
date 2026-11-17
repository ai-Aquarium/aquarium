"use client";

import Link from "next/link";

import { refHref } from "@/lib/refs";
import { isSuggested } from "@/lib/suggested-tasks/channels";

import { SuggestedTaskList } from "./SuggestedTaskList";
import { useSuggestedTasks } from "./useSuggestedTasks";

/**
 * The message page's side card: the suggested task triage raised from this
 * message (Work on this / Snooze / Dismiss), or the task it already became.
 */
export function MessageSuggestion({
  incomingId,
  canStart = true,
}: {
  incomingId: string;
  canStart?: boolean;
}) {
  const feed = useSuggestedTasks(
    `source_ref=${encodeURIComponent(incomingId)}&stage=open,staged,working,review`,
  );
  if (!feed.loaded || feed.items.length === 0) return null;
  const suggestions = feed.items.filter((t) => isSuggested(t.todo));
  const started = feed.items.filter((t) => !isSuggested(t.todo));
  return (
    <section data-component="MessageSuggestion" aria-label="Suggested tasks from this message" className="flex flex-col gap-2">
      {suggestions.length > 0 ? (
        <SuggestedTaskList tasks={suggestions} compact canStart={canStart} onRemoved={feed.remove} />
      ) : null}
      {started.map(({ todo }) => {
        const href = todo.project?.url || (todo.project ? `/projects/${encodeURIComponent(todo.project.slug)}` : todo.ref ? refHref(todo.ref) : null);
        return (
          <div
            key={todo.id}
            data-component="MessageTaskStarted"
            className="flex flex-col gap-1.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          >
            <p className="text-sm font-semibold">Task started</p>
            <p className="text-sm [overflow-wrap:anywhere]">{todo.project?.name ?? todo.title}</p>
            {href ? (
              <Link
                href={href}
                className="inline-flex min-h-10 w-fit items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent-fg)]"
              >
                Open task{todo.project?.ref ? ` ${todo.project.ref}` : ""}
              </Link>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
