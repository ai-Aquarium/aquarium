/**
 * PUT — who gets a data source's Needs you cards (`user_id`; empty sends them
 * to every owner and admin). Hermes checks that caller and assignee are owner or admin.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.user_id !== "string") {
    return NextResponse.json({ error: "invalid_body", detail: "Give user_id (empty for no one)." }, { status: 400 });
  }
  try {
    return NextResponse.json(await (await apiClientForRequest()).putDataAssignee(id, body.user_id));
  } catch (err) {
    return hermesError(err);
  }
}
