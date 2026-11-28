/** PUT /api/profiles/named/[name]/creature — the creature that stands for a profile (owner/admin). */
import {
  BAD_JSON,
  badRequest,
  readJsonBody,
  refuse,
  str,
  upstream,
} from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { isCreatureId } from "@/lib/aquarium/creatures";

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const creature = str(body.creature);
  if (!isCreatureId(creature))
    return badRequest("Pick one of the Aquarium creatures.");
  const client = await apiClientForRequest();
  return upstream(() => client.setProfileCreature(name, creature));
}
