/**
 * GET / PUT — the schemas a source's first study covers (`chosen`) and every
 * schema it has (`available`). Changing them needs manage access in Hermes.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await (await apiClientForRequest()).studySchemas(id));
  } catch (err) {
    return hermesError(err);
  }
}

export async function PUT(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  const schemas = body.schemas;
  if (!Array.isArray(schemas) || !schemas.every((s) => typeof s === "string")) {
    return NextResponse.json({ error: "invalid_body", detail: "Give schemas as a list of names." }, { status: 400 });
  }
  try {
    return NextResponse.json(await (await apiClientForRequest()).putStudySchemas(id, schemas));
  } catch (err) {
    return hermesError(err);
  }
}
