/**
 * GET /api/branding/logo — the owner's uploaded logo (PNG, JPEG, GIF or
 * WebP). Public, like the sign-in page that shows it; 404 when none is set.
 */
import { NextResponse } from "next/server";

import { HermesApiClient } from "@/lib/api/client";
import { isBrandingLogoType } from "@/lib/branding/branding";

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(): Promise<NextResponse> {
  let res: Response;
  try {
    res = await new HermesApiClient().brandingLogo();
  } catch {
    return NextResponse.json({ error: "api_unreachable" }, { status: 502 });
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!res.ok || !isBrandingLogoType(type)) return notFound();
  return new NextResponse(await res.arrayBuffer(), {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}
