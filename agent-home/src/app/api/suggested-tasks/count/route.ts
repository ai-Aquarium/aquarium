/**
 * GET /api/suggested-tasks/count?todo_ids=a,b — every suggested task the
 * caller has, counted server-side, and which of the given to-do ids (the
 * Needs-you alerts on screen) are among them. The Needs-you badge uses it so
 * it counts past the first loaded page and doesn't count a task twice.
 */
import type { NextResponse } from "next/server";

import { withPrincipal } from "../../projects/hermes-bridge";

/** The backend's `MAX_SUGGESTED_PROBES`. */
const MAX_PROBES = 200;

export async function GET(req: Request): Promise<NextResponse> {
  const ids = (new URL(req.url).searchParams.get("todo_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_PROBES);
  return withPrincipal(async (client) => {
    const res = await client.suggestedTodosCount(ids);
    return { count: res.count, suggested_todo_ids: res.suggested_ids ?? [] };
  });
}
