import { AllChatsView } from "@/components/chat/AllChatsView";
import { MobileShell } from "@/components/MobileShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import type { SessionSummary } from "@/types";

export const dynamic = "force-dynamic";

/** "All chats": every conversation of the session's profile, using the whole page. */
export default async function Page() {
  await requirePrincipal();
  const profile = (await readSession())?.profile ?? "default";

  let sessions: SessionSummary[] = [];
  let error: string | null = null;
  try {
    const client = await apiClientForRequest({ profile });
    sessions = (await client.allSessions({ order: "recent", excludeSources: "project_chat" })).sessions;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load conversations";
  }

  return (
    <MobileShell title="All chats" wide fill>
      {error ? (
        <div data-component="ChatError" className="mx-auto w-full max-w-lg">
          <ErrorState kind="error" details={error} />
        </div>
      ) : (
        <AllChatsView profile={profile} initialSessions={sessions} />
      )}
    </MobileShell>
  );
}
