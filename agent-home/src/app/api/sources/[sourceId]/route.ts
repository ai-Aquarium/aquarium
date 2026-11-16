/** DELETE /api/sources/{sourceId} — remove one of the caller's own sources. */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

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
