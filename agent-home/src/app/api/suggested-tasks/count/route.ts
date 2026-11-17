/**
 * GET /api/suggested-tasks/count — every suggested task the caller has,
 * counted server-side, so the Needs-you badge counts past the first loaded
 * page. Needs you marks the alerts those tasks stand for (`context.suggested`).
 */
import type { NextResponse } from "next/server";

import { withPrincipal } from "../../projects/hermes-bridge";

export async function GET(): Promise<NextResponse> {
  return withPrincipal(async (client) => {
    const res = await client.suggestedTodosCount();
    return { count: res.count };
  });
}
