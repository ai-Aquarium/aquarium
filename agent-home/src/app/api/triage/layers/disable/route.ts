/**
 * POST /api/triage/layers/disable — turn one triage skill key off or back on
 * in the caller's own layer or (owner/admin of the addressed `?profile=`,
 * checked by Hermes) the profile template.
 */
import { NextResponse } from "next/server";

import { unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import type { TriageEditableLayer } from "@/types";

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const kind = str(body.kind);
  const key = str(body.key);
  const layer = str(body.layer);
  if (!kind || !key || (layer !== "template" && layer !== "user") || typeof body.disabled !== "boolean") {
    return badRequest("kind, layer (template or user), key and disabled are required.");
  }
  const disabled = body.disabled;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.setTriageLayerDisabled(kind, layer as TriageEditableLayer, key, disabled));
}
