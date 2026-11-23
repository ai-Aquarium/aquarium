import { NextResponse } from "next/server";

import { withPrincipal } from "../../hermes-bridge";

const ACTORS = new Set(["all", "people", "agents"]);

/** The project Log (Stage 6): one page of people + agent activity. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const search = new URL(req.url).searchParams;
  const actor = search.get("actor") ?? undefined;
  if (actor != null && !ACTORS.has(actor)) {
    return NextResponse.json({ detail: "actor must be all, people or agents" }, { status: 400 });
  }
  const rawLimit = search.get("limit");
  const limit = rawLimit != null ? Number(rawLimit) : undefined;
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
    return NextResponse.json({ detail: "limit must be a positive integer" }, { status: 400 });
  }
  return withPrincipal((client) =>
    client.projectLog(slug, {
      actor,
      kind: search.get("kind") ?? undefined,
      cursor: search.get("cursor") ?? undefined,
      limit,
    }),
  );
}
