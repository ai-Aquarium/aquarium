/**
 * GET /api/branding — the box's entity name and logo metadata. Public: the
 * sign-in page shows them before anyone is signed in.
 */
import { NextResponse } from "next/server";

import { getBranding } from "@/lib/branding/server";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getBranding());
}
