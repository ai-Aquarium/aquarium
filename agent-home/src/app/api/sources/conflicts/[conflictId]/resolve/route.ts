/**
 * POST /api/sources/conflicts/{conflictId}/resolve {action: "keep" | "transfer"}
 * — box owner/admin settles a claim. Hermes enforces the admin check.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { hermesError, unauthenticated } from "../../../_shared";

type Ctx = { params: Promise<{ conflictId: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { conflictId } = await ctx.params;
  const id = Number(conflictId);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "invalid_conflict" }, { status: 400 });
  }
  let action: unknown;
  try {
    action = ((await req.json()) as { action?: unknown } | null)?.action;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (action !== "keep" && action !== "transfer") {
    return NextResponse.json({ error: "invalid_body", detail: "action must be keep or transfer." }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.resolveSourceConflict(id, action));
  } catch (err) {
    return hermesError(err);
  }
}
