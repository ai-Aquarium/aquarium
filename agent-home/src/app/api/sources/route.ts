/**
 * GET / POST /api/sources — FG-03 P2: the caller's incoming sources (mailbox,
 * WhatsApp number, Telegram bot) with their routes, and registering one.
 * Hermes owns the one-owner-per-source rule and the owner checks.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { maskPhoneNumbers } from "@/lib/sources/mask";
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
    // A refusal about a typed WhatsApp number must not echo it back unmasked.
    const safe =
      body.channel === "whatsapp" && err instanceof HermesApiError
        ? new HermesApiError(err.status, maskPhoneNumbers(err.message), maskedBody(err.body))
        : err;
    return claimError(safe) ?? hermesError(safe);
  }
}

/** A refused claim (409) keeps the current owner's display name for the conflict screen. */
function claimError(err: unknown): NextResponse | null {
  if (!(err instanceof HermesApiError) || err.status !== 409) return null;
  const owner = (err.body as { owner_display?: unknown } | undefined)?.owner_display;
  if (typeof owner !== "string" || !owner.trim()) return null;
  return NextResponse.json({ error: "api_error", detail: err.message, owner_display: owner }, { status: 409 });
}

function maskedBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === "string" ? { ...body, detail: maskPhoneNumbers(detail) } : body;
}
