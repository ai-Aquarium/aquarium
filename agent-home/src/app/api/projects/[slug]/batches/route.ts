import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.listProjectBatches(slug));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const body = await readBody(req);
  return withPrincipal((client) =>
    client.createProjectBatch(slug, {
      title: String(body.title ?? ""),
      description: body.description ? String(body.description) : undefined,
    }),
  );
}
