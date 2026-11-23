/**
 * GET /api/projects/:slug/chat/timeline — the project group chat: every
 * member's per-profile conversations and members-only messages merged into
 * one time-ordered list, each turn labelled with its person and profile, plus
 * the playbook revisions proposed while it ran. Read permission only.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.projectChatTimeline(slug));
}
