/**
 * POST /api/fleet/switch {box, layout, password} — owner only. The Python API
 * re-checks the owner's own password with the login provider, then the target
 * box starts the layout switch as a detached systemd unit and this returns at
 * once (202). "git" = direct deploy, "release" = software upgrade.
 */
import { NextResponse } from "next/server";

import { BAD_JSON, badRequest, readJsonBody, str } from "@/lib/api/admin-route";
import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

const BOX = /^[a-z0-9][a-z0-9-]{0,30}$/;

export async function POST(request: Request): Promise<NextResponse> {
  const gate = await requireMemberOwner("Only the owner can switch a box's layout.");
  if ("response" in gate) return gate.response;
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const box = str(body.box);
  const layout = str(body.layout);
  const password = typeof body.password === "string" ? body.password : "";
  if (!BOX.test(box)) return badRequest("Unknown box.");
  if (layout !== "git" && layout !== "release") {
    return badRequest("Pick 'direct deploy' or 'software upgrade'.");
  }
  if (!password) return badRequest("Enter your password to confirm.");
  try {
    return NextResponse.json(
      await gate.client.fleetSwitch({ box, layout, password }),
      { status: 202 },
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
