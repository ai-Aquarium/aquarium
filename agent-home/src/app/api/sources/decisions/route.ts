/** GET /api/sources/decisions — why each of the caller's batches went to which profile. */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { hermesError, unauthenticated } from "../_shared";

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const params = new URL(req.url).searchParams;
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.sourceDecisions({
        sourceId: params.get("source_id") || undefined,
        batchId: params.get("batch_id") || undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        all: params.get("all") === "1",
      }),
    );
  } catch (err) {
    return hermesError(err);
  }
}
