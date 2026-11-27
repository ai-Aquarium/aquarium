import { NextResponse } from "next/server";

import { withPrincipal } from "../../../../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; rev: string }> },
): Promise<NextResponse> {
  const { slug, rev } = await params;
  return withPrincipal((client) => client.getRequirementRev(slug, Number(rev)));
}
