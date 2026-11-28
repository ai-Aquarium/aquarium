/**
 * GET /api/fleet/job — the progress poll for in-flight layout switches, keyed
 * by box name. Owner only. While a switch runs the fleet page polls this.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

export async function GET(): Promise<NextResponse> {
  const gate = await requireMemberOwner("Only the owner can manage the fleet.");
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.fleetJob());
  } catch (err) {
    return forwardMemberError(err);
  }
}
