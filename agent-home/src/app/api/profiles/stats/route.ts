/** GET /api/profiles/stats?days=30 — per-profile activity for the Profiles cards (owner/admin). */
import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const raw = Number(new URL(request.url).searchParams.get("days") ?? 30);
  const days = Number.isFinite(raw)
    ? Math.min(365, Math.max(1, Math.round(raw)))
    : 30;
  const client = await apiClientForRequest();
  return upstream(() => client.profileStats(days));
}
