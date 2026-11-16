/**
 * PUT /api/triage/layers/care — save the required "What I care about"
 * section in the caller's own layer or (owner/admin of the addressed
 * `?profile=`, checked by Hermes) the profile template. Hermes refuses empty
 * text (422); the BFF only checks the shape.
 */
import { NextResponse } from "next/server";

import { unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import type { TriageEditableLayer } from "@/types";

export async function PUT(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const kind = str(body.kind);
  const layer = str(body.layer);
  if (!kind || (layer !== "template" && layer !== "user") || typeof body.content !== "string") {
    return badRequest("kind, layer (template or user) and content are required.");
  }
  const content = body.content;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.saveTriageCare(kind, layer as TriageEditableLayer, content));
}
