import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../../hermes-bridge";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; batchId: string }> },
): Promise<NextResponse> {
  const { slug, batchId } = await params;
  const body = await readBody(req);
  return withPrincipal((client) =>
    client.updateProjectBatch(slug, batchId, {
      title: body.title !== undefined ? String(body.title) : undefined,
      description:
        body.description !== undefined ? String(body.description) : undefined,
      archived:
        body.archived !== undefined ? Boolean(body.archived) : undefined,
    }),
  );
}
