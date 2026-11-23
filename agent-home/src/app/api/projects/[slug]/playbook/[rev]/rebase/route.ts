/**
 * POST /api/projects/:slug/playbook/:rev/rebase — update a proposal written
 * from an older revision onto the active one (member+); it stays proposed.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../../../hermes-bridge";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; rev: string }> },
): Promise<NextResponse> {
  const { slug, rev } = await params;
  const revNo = Number(rev);
  if (!Number.isInteger(revNo)) {
    return NextResponse.json(
      { error: "invalid_request", detail: "Revision must be an integer." },
      { status: 400 },
    );
  }
  return withPrincipal((client) => client.rebaseProjectPlaybook(slug, revNo));
}
