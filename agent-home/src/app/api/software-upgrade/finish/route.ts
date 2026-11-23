/**
 * POST /api/software-upgrade/finish — owner or admin: "Try again" after the box's
 * automatic system-helper step failed. It installs only files of the release that
 * already runs, from its verified package, so no password is asked.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

export async function POST(): Promise<NextResponse> {
  const gate = await requireMemberAdmin();
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.finishSoftwareUpgrade(), { status: 202 });
  } catch (err) {
    return forwardMemberError(err);
  }
}
