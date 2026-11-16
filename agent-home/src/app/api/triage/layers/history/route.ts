/**
 * GET /api/triage/layers/history?kind&key&layer — saved versions of one
 * triage skill key in the profile template or the caller's own layer, newest
 * first, bound to `?profile=`.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { badRequest, str } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import type { TriageEditableLayer } from "@/types";

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const url = new URL(request.url);
  const kind = str(url.searchParams.get("kind"));
  const key = str(url.searchParams.get("key"));
  const layer = str(url.searchParams.get("layer"));
  if (!kind || !key || (layer !== "template" && layer !== "user")) {
    return badRequest("kind, key and layer (template or user) are required.");
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.triageLayerHistory(kind, key, layer as TriageEditableLayer));
  } catch (err) {
    return hermesError(err);
  }
}
