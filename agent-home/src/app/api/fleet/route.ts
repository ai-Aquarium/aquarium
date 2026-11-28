/**
 * GET /api/fleet — Settings → Fleet: the boxes this server manages, what runs
 * where, and any layout switch in flight. Owner only, here and in the Python
 * API; on a server without a fleet config the answer is `available: false`.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

export async function GET(): Promise<NextResponse> {
  const gate = await requireMemberOwner("Only the owner can manage the fleet.");
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.fleet());
  } catch (err) {
    return forwardMemberError(err);
  }
}
