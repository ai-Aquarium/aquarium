/**
 * DELETE /api/projects/:slug/playbook/drafts/:userId — discard a member's
 * working draft: the owner's own (`me`), or anyone's for a lead.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../../../hermes-bridge";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; userId: string }> },
): Promise<NextResponse> {
  const { slug, userId } = await params;
  return withPrincipal((client) => client.discardProjectPlaybookDraft(slug, userId));
}
