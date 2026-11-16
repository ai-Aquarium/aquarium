/**
 * PATCH /api/sources/{sourceId} — turn one of the caller's own sources on/off
 * or rename it; DELETE removes it. Hermes owns the owner-only rule.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { SourceUpdate } from "@/types";

import { hermesError, unauthenticated } from "../_shared";

type Ctx = { params: Promise<{ sourceId: string }> };

export async function PATCH(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { sourceId } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = raw as Record<string, unknown>;
  const body: SourceUpdate = {};
  if (typeof input.enabled === "boolean") body.enabled = input.enabled;
  if (typeof input.display === "string" || input.display === null) body.display = input.display as string | null;
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: "invalid_body", detail: "Send enabled or display." }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.updateSource(sourceId, body));
  } catch (err) {
    return hermesError(err);
  }
}

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
