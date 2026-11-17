/**
 * GET /api/suggested-tasks/:id — one system to-do as a task page shows it:
 * its D ref, stage and (once started) the project it became. 404 covers both
 * "no such to-do" and "not yours".
 */
import type { NextResponse } from "next/server";

import { withPrincipal } from "../../projects/hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return withPrincipal(async (client) => {
    const todo = await client.todo(id);
    return {
      id: todo.id,
      ref: todo.ref ?? null,
      title: todo.title,
      stage: todo.stage,
      closed_at: todo.closed_at,
      project: todo.project ?? null,
    };
  });
}
