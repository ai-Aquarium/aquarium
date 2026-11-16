/**
 * POST /api/sources/conflicts/{conflictId}/resolve — settle a source claim
 * conflict: `keep` (the current owner keeps it) or `transfer` (it moves to the
 * claimant). Box owner/admin only; Hermes checks.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { SourceConflictAction } from "@/types";

import { hermesError, unauthenticated } from "../../../_shared";

type Ctx = { params: Promise<{ conflictId: string }> };

const ACTIONS: readonly SourceConflictAction[] = ["keep", "transfer"];

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { conflictId } = await ctx.params;
  const id = Number(conflictId);
  if (!/^\d+$/.test(conflictId) || !Number.isSafeInteger(id)) {
    return NextResponse.json({ error: "invalid_conflict_id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = (body as { action?: unknown } | null)?.action;
  if (!ACTIONS.includes(action as SourceConflictAction)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.resolveSourceConflict(id, action as SourceConflictAction),
    );
  } catch (err) {
    return hermesError(err);
  }
}
