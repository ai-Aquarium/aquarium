/**
 * GET / POST /api/sources — FG-03 P2: the caller's incoming sources (mailbox,
 * WhatsApp number, Telegram bot) with their routes, and registering one.
 * Hermes owns the one-owner-per-source rule and the owner checks.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { SourceInput } from "@/types";

import { hermesError, unauthenticated } from "./_shared";

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const all = new URL(req.url).searchParams.get("all") === "1";
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.sources(all));
  } catch (err) {
    return hermesError(err);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  let body: SourceInput;
  try {
    body = (await req.json()) as SourceInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.registerSource(body));
  } catch (err) {
    return hermesError(err);
  }
}
