/** GET /api/sources/conflicts — refused / disputed claims the caller is part of. */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { hermesError, unauthenticated } from "../_shared";

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const all = new URL(req.url).searchParams.get("all") === "1";
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.sourceConflicts(all));
  } catch (err) {
    return hermesError(err);
  }
}
