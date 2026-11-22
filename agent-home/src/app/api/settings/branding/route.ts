/**
 * PUT /api/settings/branding {name} — the box's entity name ("" clears it).
 * Owner only; Python re-checks and validates.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import { requireMemberOwner } from "@/lib/api/member-bff";
import { BRANDING_NAME_MAX, BRANDING_OWNER_ONLY as OWNER_ONLY } from "@/lib/branding/branding";
import { rememberBranding } from "@/lib/branding/server";

export async function PUT(req: Request): Promise<NextResponse> {
  const owner = await requireMemberOwner(OWNER_ONLY);
  if ("response" in owner) return owner.response;
  const { name } = await readBody(req);
  if (typeof name !== "string") {
    return NextResponse.json({ error: "invalid_body", detail: "name must be a string." }, { status: 400 });
  }
  if (Array.from(name.trim()).length > BRANDING_NAME_MAX) {
    return NextResponse.json(
      { error: "invalid_body", detail: `name must be at most ${BRANDING_NAME_MAX} characters.` },
      { status: 400 },
    );
  }
  return withPrincipal(async (client) => rememberBranding(await client.setBrandingName(name)));
}
