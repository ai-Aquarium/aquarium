import type {
  ChatMessage,
  ProfileSummary,
  ProjectChatProposal,
  ProjectChatTimeline,
} from "@/types";

/** The merged timeline as chat rows, each carrying its profile. */
export function timelineMessages(timeline: ProjectChatTimeline | null): ChatMessage[] {
  if (!timeline) return [];
  return timeline.messages.map((m) => {
    const row: ChatMessage = {
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      profile: m.profile,
    };
    if (m.id != null) row.id = m.id;
    if (m.catch_up) row.catchUp = m.catch_up;
    if (m.seeded) row.seeded = true;
    if (m.sent_while_working) row.sentWhileWorking = true;
    return row;
  });
}

/** The conversation `profile` keeps in this project, if it has one yet. */
export function sessionFor(
  timeline: ProjectChatTimeline | null,
  profile: string,
): string | null {
  return timeline?.sessions.find((s) => s.profile === profile)?.session_id ?? null;
}

/**
 * Turns of other profiles after `profile`'s own last turn: what its next
 * user turn's catch-up will cover (mirrors `missed_turns` in the API).
 */
export function missedCount(messages: ChatMessage[], profile: string): number {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.profile === profile) last = i;
  });
  return messages.slice(last + 1).filter((m) => m.profile && m.profile !== profile).length;
}

function seconds(ts: ChatMessage["timestamp"]): number | null {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const n = Number(ts);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(ts);
    return Number.isFinite(d) ? d / 1000 : null;
  }
  return null;
}

/**
 * Where each proposal card goes: after the last message saved at or before
 * the revision (proposals are saved by a turn, so they land under its reply).
 * Keyed by message index; a proposal older than every message goes first (-1).
 */
export function placeProposals(
  messages: ChatMessage[],
  proposals: ProjectChatProposal[],
): Map<number, ProjectChatProposal[]> {
  const out = new Map<number, ProjectChatProposal[]>();
  const stamps = messages.map((m) => seconds(m.timestamp));
  for (const p of proposals) {
    const at = p.created_at ?? Number.POSITIVE_INFINITY;
    let idx = -1;
    stamps.forEach((s, i) => {
      // Rows without a stamp (the live turn) follow the last stamped row.
      if (s === null ? idx === i - 1 : Math.floor(s) <= at) idx = i;
    });
    out.set(idx, [...(out.get(idx) ?? []), p]);
  }
  return out;
}

/**
 * Who the picker offers: the caller's profiles that are on the project, or
 * every profile they may use when none is (a fresh project).
 */
export function pickerProfiles(
  enrolled: ProfileSummary[],
  projectProfiles: string[],
  current: string,
): ProfileSummary[] {
  const on = enrolled.filter((p) => projectProfiles.includes(p.name));
  const list = on.length ? on : enrolled;
  if (!list.some((p) => p.name === current)) {
    return [...list, { name: current, is_default: false, description: "" }];
  }
  return list;
}
