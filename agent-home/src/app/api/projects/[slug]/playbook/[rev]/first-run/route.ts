/**
 * POST /api/projects/:slug/playbook/:rev/first-run — make `rev` active and
 * start run 1 as one human act (lead/admin). A repeat returns run 1 and
 * starts nothing.
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
  return withPrincipal((client) => client.startProjectFirstRun(slug, revNo));
}
