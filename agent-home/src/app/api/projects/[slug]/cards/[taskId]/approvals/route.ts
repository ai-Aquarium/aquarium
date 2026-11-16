/**
 * POST /api/projects/:slug/cards/:taskId/approvals — answer an approval the
 * card's worker asked for: `{ key, decision: "approve" | "deny" }`. A
 * proposed message (`send:` key) is sent by `approve`, and also takes
 * `{ decision: "revise", note }` to send the draft back with a note.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../../../hermes-bridge";

const NOTE_MAX = 2000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; taskId: string }> },
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const body = await readBody(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const decision = body.decision;
  if (!key || (decision !== "approve" && decision !== "deny" && decision !== "revise")) {
    return NextResponse.json(
      { detail: "key and a decision of 'approve', 'deny' or 'revise' are required" },
      { status: 422 },
    );
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (decision === "revise" && (!note || note.length > NOTE_MAX)) {
    return NextResponse.json(
      { detail: `revise needs a note of at most ${NOTE_MAX} characters` },
      { status: 422 },
    );
  }
  return withPrincipal((client) =>
    decision === "revise"
      ? client.decideProjectCardApproval(slug, taskId, key, decision, note)
      : client.decideProjectCardApproval(slug, taskId, key, decision),
  );
}
