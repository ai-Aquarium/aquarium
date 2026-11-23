/**
 * POST /api/software-upgrade/check [{version}] — "check now": ask GitHub for
 * releases; with a version, also the pre-flight checks for it (disk, backup
 * folder, services, release signature, work in progress). Read-only. Owner and admin.
 */
import { NextResponse } from "next/server";

import { badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister, canUpgradeSoftware } from "@/lib/auth/roles";

const VERSION = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,40})?$/;

export async function POST(request?: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = request ? await readJsonBody(request) : null;
  const version = body ? str(body.version) : "";
  if (version && !VERSION.test(version)) return badRequest("Pick a release like v1.2.3.");
  const client = await apiClientForRequest();
  return upstream(
    () => client.checkSoftwareUpgrade(version || undefined),
    (data) => ({ ...data, can_upgrade: canUpgradeSoftware(principal) }),
  );
}
