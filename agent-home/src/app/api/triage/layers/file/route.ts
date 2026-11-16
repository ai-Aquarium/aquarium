/**
 * GET/PUT /api/triage/layers/file — one triage skill key in the addressed
 * `?profile=` (FG-03 P3). GET reads the winning text (`layer=effective`) or
 * one layer's (`builtin|template|user`). PUT saves it in the caller's own
 * layer (`user`) or the profile's template; Hermes allows the template only
 * to that profile's owner/admins (the caller's role there, not here), so the
 * BFF forwards and replays its 403.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import type { TriageLayerView, TriageEditableLayer } from "@/types";

const VIEWS: readonly string[] = ["effective", "builtin", "template", "user"];
const EDITABLE: readonly string[] = ["template", "user"];

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const url = new URL(request.url);
  const kind = str(url.searchParams.get("kind"));
  const key = str(url.searchParams.get("key"));
  const layer = str(url.searchParams.get("layer")) || "effective";
  if (!kind || !key) return badRequest("kind and key are required.");
  if (!VIEWS.includes(layer)) return badRequest("layer must be effective, builtin, template or user.");
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.triageLayerFile(kind, key, layer as TriageLayerView));
  } catch (err) {
    return hermesError(err);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const kind = str(body.kind);
  const key = str(body.key);
  const layer = str(body.layer);
  if (!kind || !key || !EDITABLE.includes(layer) || typeof body.content !== "string") {
    return badRequest("kind, layer (template or user), key and content are required.");
  }
  const content = body.content;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.saveTriageLayerFile(kind, layer as TriageEditableLayer, key, content));
}
