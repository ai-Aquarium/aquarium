/**
 * GET /api/fleet/available — the Settings tile's cheap probe: does this server
 * manage a fleet at all? No SSH, no box probing. Owner only.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

export async function GET(): Promise<NextResponse> {
  const gate = await requireMemberOwner("Only the owner can manage the fleet.");
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.fleetAvailable());
  } catch (err) {
    return forwardMemberError(err);
  }
}
