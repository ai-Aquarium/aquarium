/**
 * POST /api/triage/layers/reset — "Reset to template": drop the caller's own
 * version of one key, or of every key and the "What I care about" section
 * when `key` is omitted. Bound to `?profile=`.
 */
import { NextResponse } from "next/server";

import { unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const kind = str(body.kind);
  if (!kind) return badRequest("kind is required.");
  if (body.key !== undefined && body.key !== null && !str(body.key)) {
    return badRequest("key must be a non-empty string when given.");
  }
  const key = str(body.key) || undefined;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.resetTriageLayer(kind, key));
}
