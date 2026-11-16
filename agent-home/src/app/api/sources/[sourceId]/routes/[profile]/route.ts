/**
 * PUT /api/sources/{sourceId}/routes/{profile} — turn a route on/off. Only the
 * source's owner may, and only to a profile they are active in (Hermes checks).
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { hermesError, unauthenticated } from "../../../_shared";

type Ctx = { params: Promise<{ sourceId: string; profile: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { sourceId, profile } = await ctx.params;
  let body: { enabled?: unknown };
  try {
    body = (await req.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.putSourceRoute(sourceId, profile, body.enabled));
  } catch (err) {
    return hermesError(err);
  }
}
