/**
 * POST /api/suggested-tasks/:id/snooze — hide a suggested task until `until`
 * (the card's Snooze: tomorrow morning). Re-arms its notification for then.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../../projects/hermes-bridge";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const until = String((await readBody(req)).until ?? "").trim();
  if (!until || Number.isNaN(Date.parse(until))) {
    return NextResponse.json(
      { error: "invalid_request", detail: "A snooze needs an end time." },
      { status: 400 },
    );
  }
  return withPrincipal((client) => client.snoozeTodo(id, until));
}
