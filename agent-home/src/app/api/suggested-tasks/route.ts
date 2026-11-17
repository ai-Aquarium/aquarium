/**
 * GET /api/suggested-tasks — the caller's suggested tasks: open and staged
 * system to-dos (`hermes todos`), each with the channel it came in on and its
 * source message, for the Inbox, the Projects strip and Needs you.
 *
 * Kept apart from `/api/todos` on purpose: hiding the To-dos app for a role
 * blocks `/api/todos`, while suggested tasks live on Inbox, Projects and
 * Needs you. Snoozed to-dos stay hidden.
 *
 * `?source_ref=<arrival id>` narrows to one message; with it, `stage` may
 * also ask for `working,review` so the message page can link the task.
 */
import type { NextResponse } from "next/server";

import { readSession } from "@/lib/auth/session";
import { loadSuggestedTasks } from "@/lib/suggested-tasks/server";
import { SUGGESTED_STAGES } from "@/lib/suggested-tasks/channels";

import { withPrincipal } from "../projects/hermes-bridge";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MESSAGE_STAGES = new Set(["open", "staged", "working", "review"]);

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const sourceRef = (params.get("source_ref") ?? "").trim() || undefined;
  const asked = (params.get("stage") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && (sourceRef ? MESSAGE_STAGES.has(s) : (SUGGESTED_STAGES as readonly string[]).includes(s)));
  const stages = asked.length > 0 ? asked : [...SUGGESTED_STAGES];
  const limit = Math.max(1, Math.min(Number(params.get("limit")) || DEFAULT_LIMIT, MAX_LIMIT));
  const profile = (await readSession())?.profile ?? null;
  return withPrincipal((client) =>
    loadSuggestedTasks(client, {
      profile,
      stages,
      source_ref: sourceRef,
      limit,
      cursor: params.get("cursor") ?? undefined,
    }),
  );
}
