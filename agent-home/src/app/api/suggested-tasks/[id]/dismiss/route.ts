/**
 * POST /api/suggested-tasks/:id/dismiss — "not something I'll do": the system
 * to-do moves to `dismissed`, audited with the acting person.
 */
import type { NextResponse } from "next/server";

import { withPrincipal } from "../../../projects/hermes-bridge";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return withPrincipal((client) => client.setTodoStage(id, "dismissed", "Dismissed from suggested tasks"));
}
