/**
 * GET /api/profiles/named/[name]/skill-suggestions — library skills this
 * profile doesn't have, scored 1–10 against its goal + SOUL.md by the
 * Python endpoint (`GET /api/profiles/{name}/skill-suggestions`). The
 * Python route returns `ok: false` + a reason for expected failures (no
 * auxiliary client, library scan error) rather than an HTTP error, so the
 * page can fall back to the unscored list.
 */
import { BAD_JSON, refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  if (!name) return BAD_JSON();
  const refresh = new URL(request.url).searchParams.get("refresh");
  const client = await apiClientForRequest();
  const suffix = refresh ? "?refresh=1" : "";
  return upstream(() =>
    client.request(`/api/profiles/${encodeURIComponent(name)}/skill-suggestions${suffix}`),
  );
}
