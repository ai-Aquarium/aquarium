import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.listRequirementRevs(slug));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const body = await readBody(req);
  return withPrincipal((client) =>
    client.saveRequirementRev(slug, {
      goal: body.goal !== undefined ? String(body.goal) : undefined,
      description:
        body.description !== undefined ? String(body.description) : undefined,
      audience: body.audience !== undefined ? String(body.audience) : undefined,
      note: body.note !== undefined ? String(body.note) : undefined,
    }),
  );
}
