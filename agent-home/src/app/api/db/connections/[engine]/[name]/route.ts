/**
 * PUT / DELETE /api/db/connections/{engine}/{name} — save or remove one of the
 * caller's own MySQL / SQLite connections. Hermes owns validation (SQLite:
 * owner or admin only, under the configured folders).
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { DbConnectionInput } from "@/types";

type Ctx = { params: Promise<{ engine: string; name: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { engine, name } = await ctx.params;
  let body: DbConnectionInput;
  try {
    body = (await req.json()) as DbConnectionInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.putDbConnection(engine, name, body));
  } catch (err) {
    return hermesError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { engine, name } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.deleteDbConnection(engine, name));
  } catch (err) {
    return hermesError(err);
  }
}
