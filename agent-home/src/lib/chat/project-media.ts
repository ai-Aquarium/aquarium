import "server-only";

import { apiClientForRequest } from "@/lib/auth/principal";
import { canReadMediaPath, isMediaObjectPath } from "@/lib/supabase/storage";
import type { Principal } from "@/types";

/**
 * Whether `principal` may open the media object at `path`: always their own;
 * another person's only when `project` names a project whose group chat that
 * person attached it in and the caller is on the project (viewers included)
 * or an instance admin. Python decides the second case from the stored chat,
 * so a crafted reference cannot widen it.
 */
export async function canReadChatMedia(
  principal: Principal,
  path: string,
  project: string | null,
): Promise<boolean> {
  if (canReadMediaPath(principal, path)) return true;
  if (!project || !isMediaObjectPath(path)) return false;
  try {
    const client = await apiClientForRequest();
    return (await client.projectChatMedia(project, path)).shared === true;
  } catch {
    return false;
  }
}
