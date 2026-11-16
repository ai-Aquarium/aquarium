/**
 * PATCH /api/sources/{sourceId} — pause/resume or relabel a source (its owner,
 * or the box owner/admin; Hermes checks). DELETE — remove one of the caller's
 * own sources.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { SourceUpdate } from "@/types";

import { hermesError, unauthenticated } from "../_shared";

type Ctx = { params: Promise<{ sourceId: string }> };

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { sourceId } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.deleteSource(sourceId));
  } catch (err) {
    return hermesError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { sourceId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { enabled, display } = body as Record<string, unknown>;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (display !== undefined && display !== null && typeof display !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const update: SourceUpdate = {};
  if (enabled !== undefined) update.enabled = enabled;
  if (display !== undefined) update.display = display;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.updateSource(sourceId, update));
  } catch (err) {
    return hermesError(err);
  }
}
