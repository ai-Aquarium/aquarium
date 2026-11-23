/**
 * POST /api/projects/:slug/playbook/drafts/me/save — save the caller's own
 * working draft as a proposed revision. Nothing is activated; that stays an
 * explicit Make active.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../../../../hermes-bridge";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const body = await readBody(req);
  return withPrincipal((client) =>
    client.saveMyProjectPlaybookDraft(slug, {
      note: typeof body.note === "string" ? body.note : undefined,
      expected_version: typeof body.expected_version === "number" ? body.expected_version : undefined,
    }),
  );
}
