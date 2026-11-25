/**
 * POST /api/comms/notifications/{id}/snooze — BFF "not now" on a pending
 * FG-10 item. Body: `{ until }` (ISO-8601). The row stays pending but hides
 * from every surface until the stamp passes — same semantics as a to-do's
 * snooze. Forwards under the bridged C1 principal; C2 is enforced upstream.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

interface SnoozeBody {
  until?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ notificationId: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { notificationId } = await params;
  let body: SnoozeBody;
  try {
    body = (await request.json()) as SnoozeBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const until = typeof body.until === "string" ? body.until.trim() : "";
  if (!until || Number.isNaN(Date.parse(until))) {
    return NextResponse.json(
      { error: "invalid_until", detail: "A snooze needs an end time." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.snoozeNotification(notificationId, until));
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
