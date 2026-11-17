/**
 * POST /api/projects/quick-task — Task mode's Start task: one request becomes
 * an ordinary one-off project; the agent words the brief, drafts the plan,
 * activates it and starts run 1 (or stops after the draft with
 * `check_plan_first`). Same create + activation gates as Project mode.
 *
 * With `from_todo: {id}` it starts a suggested task: the to-do's one-off
 * project, seeded with its source message. `request` (optional) is the
 * person's own wording of the ask; the profile defaults to the serving one.
 * Starting the same to-do again returns the same project (`created: false`).
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../hermes-bridge";
import type { ProjectAutonomy } from "@/types";

const AUTONOMY: readonly ProjectAutonomy[] = ["supervised", "autonomous", "manual"];
const MAX_REQUEST = 8000;

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  const request = String(body.request ?? "").trim();
  const hostProfile = String(body.host_profile ?? "").trim();
  const fromTodo = body.from_todo as { id?: unknown } | null | undefined;
  const todoId =
    fromTodo && typeof fromTodo === "object" && typeof fromTodo.id === "string"
      ? fromTodo.id.trim()
      : "";
  if (todoId) {
    if (request.length > MAX_REQUEST) {
      return NextResponse.json(
        { error: "invalid_body", detail: "That request is too long." },
        { status: 400 },
      );
    }
    return withPrincipal((client) =>
      client.createQuickTask({
        from_todo: { id: todoId },
        ...(request ? { request } : {}),
        ...(hostProfile ? { host_profile: hostProfile } : {}),
        // A suggested task checks in at every step unless the person says otherwise.
        autonomy: (AUTONOMY as readonly string[]).includes(String(body.autonomy))
          ? (body.autonomy as ProjectAutonomy)
          : "manual",
        check_plan_first: body.check_plan_first === true,
      }),
    );
  }
  if (!request || !hostProfile) {
    return NextResponse.json(
      { error: "invalid_body", detail: "Say what the agent should do and pick a profile." },
      { status: 400 },
    );
  }
  const autonomy = (AUTONOMY as readonly string[]).includes(String(body.autonomy))
    ? (body.autonomy as ProjectAutonomy)
    : "supervised";
  return withPrincipal((client) =>
    client.createQuickTask({
      request,
      host_profile: hostProfile,
      autonomy,
      check_plan_first: body.check_plan_first === true,
    }),
  );
}
