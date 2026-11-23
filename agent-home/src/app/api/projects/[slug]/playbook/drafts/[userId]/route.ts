/**
 * DELETE /api/projects/:slug/playbook/drafts/:userId — discard a member's
 * working draft: the owner's own (`me`), or anyone's for a lead.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../../../hermes-bridge";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string; userId: string }> },
): Promise<NextResponse> {
  const { slug, userId } = await params;
  const raw = new URL(req.url).searchParams.get("expected_version");
  const expected = raw != null && /^\d+$/.test(raw) ? Number(raw) : undefined;
  return withPrincipal((client) => client.discardProjectPlaybookDraft(slug, userId, expected));
}
