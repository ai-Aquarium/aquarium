/**
 * POST /api/db/connections/{engine}/{name}/test — open the caller's saved
 * connection and count its tables. A failed test is a 200 with the reason.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

type Ctx = { params: Promise<{ engine: string; name: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { engine, name } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.testDbConnection(engine, name));
  } catch (err) {
    return hermesError(err);
  }
}
