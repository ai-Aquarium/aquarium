/**
 * GET /api/triage/layers/diff?kind&key — the profile template vs the caller's
 * own version of one triage skill key (unified diff), bound to `?profile=`.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { badRequest, str } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const url = new URL(request.url);
  const kind = str(url.searchParams.get("kind"));
  const key = str(url.searchParams.get("key"));
  if (!kind || !key) return badRequest("kind and key are required.");
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.triageLayerDiff(kind, key));
  } catch (err) {
    return hermesError(err);
  }
}
