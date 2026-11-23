/**
 * POST /api/projects/:slug/chat/messages — a members-only message in the
 * project group chat ("Ask agent" off): stored on the project, no model call;
 * each member's conversations read it in their next catch-up. Members only —
 * a viewer gets 403.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../../hermes-bridge";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const body = await readBody(req);
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) {
    return NextResponse.json(
      { error: "invalid_request", detail: "A message is required." },
      { status: 400 },
    );
  }
  return withPrincipal((client) => client.postProjectChatMessage(slug, content));
}
