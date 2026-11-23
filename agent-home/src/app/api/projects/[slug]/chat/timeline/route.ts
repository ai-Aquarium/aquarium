/**
 * GET /api/projects/:slug/chat/timeline — the project chat: the caller's own
 * per-profile conversations in this project merged into one time-ordered
 * list, each turn labelled with its profile, plus the playbook revisions
 * proposed while it ran (2026-11-22 plan, stage 2). Read permission only.
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
