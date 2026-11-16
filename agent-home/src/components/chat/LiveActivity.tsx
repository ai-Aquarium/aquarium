"use client";

import { Maximizable, MaximizeToggle } from "@/components/ui/Maximizable";
import { toolLines } from "@/lib/chat/copy-chat";
import type { ChatToolEvent } from "@/lib/chat/stream";

export interface ToolChip extends ChatToolEvent {
  done: boolean;
}

/**
 * Live "what is the agent doing" surface for a streaming turn: the model's
 * reasoning text as it arrives (so a long think never looks frozen) plus one
 * line per tool call. Muted on purpose — it is activity, not conversation.
 * "Maximize" fills the screen with the same steps and the full reasoning.
 */
export function LiveActivity({
  reasoning,
  tools,
}: {
  reasoning: string;
  tools: ToolChip[];
}) {
  if (reasoning === "" && tools.length === 0) return null;
  const lines = toolLines(tools);
  return (
    <Maximizable
      title="Agent activity"
      component="LiveActivity"
      className="mt-2 space-y-1"
    >
      {({ maximized }) => (
        <>
          {maximized ? null : (
            <div className="flex justify-end">
              <MaximizeToggle />
            </div>
          )}
          <div
            className={
              maximized
                ? "min-h-0 flex-1 space-y-1 overflow-y-auto text-sm text-[var(--color-muted)]"
                : "contents"
            }
          >
            {tools.map((t, i) => (
              <div
                key={t.id || `${t.name}-${i}`}
                className={
                  maximized ? undefined : "text-xs text-[var(--color-muted)]"
                }
              >
                {lines[i]}
              </div>
            ))}
            {reasoning !== "" ? (
              <div
                data-component="LiveReasoning"
                className={`whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 italic text-[var(--color-muted)] ${
                  maximized
                    ? "mt-3 text-sm"
                    : "max-h-24 overflow-y-auto text-xs"
                }`}
              >
                {reasoning}
              </div>
            ) : null}
          </div>
        </>
      )}
    </Maximizable>
  );
}
