import "server-only";

import type { HermesApiClient } from "@/lib/api/client";
import type { IncomingItem, SuggestedTaskSource, SuggestedTasksResponse, Todo } from "@/types";

import { toSuggestedTask } from "./channels";

/** Upstream reads in flight at once: the AI layer slows under bursts. */
const SOURCE_READS_AT_ONCE = 4;

function sourceOf(item: IncomingItem): SuggestedTaskSource {
  return {
    id: item.id,
    ref: item.ref ?? null,
    surface: item.surface,
    account_id: item.account_id,
    external_id: item.external_id,
    sender_name: item.sender_name,
    sender_id: item.sender_id,
    subject: item.subject,
    body: item.body,
    occurred_at: item.occurred_at,
  };
}

/**
 * The arrival behind each to-do, read as the caller. An arrival that is gone
 * or not visible is just "no source": the to-do still shows, untagged.
 */
async function readSources(
  client: HermesApiClient,
  todos: Todo[],
): Promise<Map<string, SuggestedTaskSource>> {
  const ids = [
    ...new Set(
      todos
        .filter((t) => t.source_kind === "inbound" && t.source_ref)
        .map((t) => t.source_ref as string),
    ),
  ];
  const found = new Map<string, SuggestedTaskSource>();
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        found.set(id, sourceOf(await client.incoming(id)));
      } catch {
        // Unreadable arrival: the card goes without its source.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SOURCE_READS_AT_ONCE, ids.length) }, worker),
  );
  return found;
}

/** A page of suggested tasks: the caller's to-dos in `stages`, with sources. */
export async function loadSuggestedTasks(
  client: HermesApiClient,
  opts: { stages: string[]; source_ref?: string; limit?: number; cursor?: string; profile?: string | null },
): Promise<SuggestedTasksResponse> {
  const page = await client.todos({
    stage: opts.stages.join(","),
    source_ref: opts.source_ref,
    limit: opts.limit,
    cursor: opts.cursor,
  });
  const sources = await readSources(client, page.items);
  return {
    items: page.items.map((todo) =>
      toSuggestedTask(todo, todo.source_ref ? (sources.get(todo.source_ref) ?? null) : null),
    ),
    next_cursor: page.next_cursor,
    profile: opts.profile ?? null,
  };
}
