/**
 * PUT /api/settings/branding/logo (multipart `file`) — upload the box logo.
 * DELETE — remove it, so the monogram shows again. Owner only; Python
 * re-checks the role and sniffs the image itself.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { requireMemberOwner } from "@/lib/api/member-bff";
import { BRANDING_LOGO_MAX_BYTES, BRANDING_OWNER_ONLY as OWNER_ONLY, isBrandingLogoType } from "@/lib/branding/branding";
import { rememberBranding } from "@/lib/branding/server";

function invalid(detail: string, status = 400): NextResponse {
  return NextResponse.json({ error: "invalid_body", detail }, { status });
}

export async function PUT(req: Request): Promise<NextResponse> {
  const owner = await requireMemberOwner(OWNER_ONLY);
  if ("response" in owner) return owner.response;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return invalid("Choose an image file.");
  if (!isBrandingLogoType(file.type)) return invalid("Use a PNG, JPEG, GIF or WebP image.");
  if (file.size > BRANDING_LOGO_MAX_BYTES) return invalid("The logo must be 1 MB or smaller.", 413);
  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  return withPrincipal(async (client) => rememberBranding(await client.setBrandingLogo(data)));
}

export async function DELETE(): Promise<NextResponse> {
  const owner = await requireMemberOwner(OWNER_ONLY);
  if ("response" in owner) return owner.response;
  return withPrincipal(async (client) => rememberBranding(await client.resetBrandingLogo()));
}
