/**
 * GET /api/triage/layers?kind= — the caller's resolved triage skills in the
 * addressed `?profile=` (FG-03 P3): each key's winning layer (built-in →
 * profile template → the caller's own version), which layers have it,
 * whether it is off, and the "What I care about" section. Hermes resolves
 * the caller in that profile; the user layer is always the caller's own.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { badRequest, str } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { targetProfileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const kind = str(new URL(request.url).searchParams.get("kind"));
  if (!kind) return badRequest("kind is required.");
  try {
    const client = await apiClientForRequest({ profile: targetProfileFromUrl(request.url) });
    return NextResponse.json(await client.triageLayers(kind));
  } catch (err) {
    return hermesError(err);
  }
}
