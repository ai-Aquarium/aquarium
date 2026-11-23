/**
 * GET /api/projects/:slug/playbook/drafts — every member's working draft of
 * the playbook. Readable by the whole project, viewers included.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.listProjectPlaybookDrafts(slug));
}
