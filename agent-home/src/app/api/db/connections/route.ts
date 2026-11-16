/**
 * GET /api/db/connections — the caller's own MySQL and SQLite connections
 * (data sources) and which drivers are installed. Never returns a password.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.dbConnections());
  } catch (err) {
    return hermesError(err);
  }
}
