"use client";

import { useRouter } from "next/navigation";

import { ChatsPanel } from "@/components/landing/chats/ChatsPanel";
import { chatHref, chatsApi } from "@/components/landing/chats/chatsApi";
import { highlightTermOf } from "@/components/landing/chats/MessageSearch";
import { readViewing } from "@/lib/viewing";
import type { SessionSummary } from "@/types";

/** The full-page chat list behind "All chats": every chat, grouped by category, as a grid. */
export function AllChatsView({ profile, initialSessions }: { profile: string; initialSessions: SessionSummary[] }) {
  const router = useRouter();
  return (
    <div data-component="AllChatsView" className="flex min-h-0 w-full flex-1 flex-col">
      <ChatsPanel
        profile={profile}
        initialSessions={initialSessions}
        categoryFilter
        showAll
        layout="page"
        searchShortcut="hint"
        messageSearch={(q, signal) => chatsApi.searchMessages(q, signal, profile, readViewing())}
        onOpenMessageHit={(hit) =>
          router.push(`${chatHref(hit.session_id, profile)}&find=${encodeURIComponent(highlightTermOf(hit.snippet))}`)
        }
      />
    </div>
  );
}
