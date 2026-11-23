import { describe, expect, it } from "vitest";

import {
  isOwnTurn,
  missedCount,
  pickerProfiles,
  placeProposals,
  sessionFor,
  timelineMessages,
} from "@/components/projects/chat/projectTimeline";
import type { ChatMessage, ProjectChatProposal, ProjectChatTimeline } from "@/types";

const turn = (profile: string, role: "user" | "assistant", content: string, timestamp: number) => ({
  profile,
  role,
  content,
  timestamp,
  session_id: `s-${profile}`,
});

const timeline: ProjectChatTimeline = {
  sessions: [
    { profile: "research", session_id: "s-research" },
    { profile: "finance", session_id: "s-finance" },
  ],
  messages: [
    turn("research", "user", "Find sources", 10),
    turn("research", "assistant", "Found three", 11),
    { ...turn("finance", "user", "Cost it", 20), catch_up: 2, seeded: true },
    turn("finance", "assistant", "About $40", 21),
  ],
  truncated: false,
  proposals: [],
  last_profile: "finance",
};

const proposal = (rev: number, created_at: number | null): ProjectChatProposal => ({
  rev,
  base_rev: rev - 1,
  active: false,
  created_at,
  created_by: null,
  note: null,
  added: 1,
  removed: 0,
  changed: 0,
  added_titles: [],
});

describe("project chat timeline", () => {
  it("keeps every turn's profile and the catch-up / seed marks", () => {
    const rows = timelineMessages(timeline);
    expect(rows.map((m) => m.profile)).toEqual(["research", "research", "finance", "finance"]);
    expect(rows[2]).toMatchObject({ catchUp: 2, seeded: true });
    expect(rows[0].catchUp).toBeUndefined();
  });

  it("finds each profile's own conversation", () => {
    expect(sessionFor(timeline, "finance")).toBe("s-finance");
    expect(sessionFor(timeline, "writer")).toBeNull();
  });

  it("counts only other profiles' turns after the picked profile's last turn", () => {
    const rows = timelineMessages(timeline);
    expect(missedCount(rows, "research")).toBe(2);
    expect(missedCount(rows, "finance")).toBe(0);
    // A profile that never spoke has missed everything.
    expect(missedCount(rows, "writer")).toBe(4);
    // Live rows (no profile yet) are never counted as missed.
    expect(missedCount([...rows, { role: "user", content: "x" } as ChatMessage], "research")).toBe(2);
  });

  it("puts a proposal under the turn that saved it", () => {
    const rows = timelineMessages(timeline);
    const placed = placeProposals(rows, [proposal(2, 11), proposal(3, 5), proposal(4, 99)]);
    expect(placed.get(1)?.map((p) => p.rev)).toEqual([2]);
    expect(placed.get(-1)?.map((p) => p.rev)).toEqual([3]);
    expect(placed.get(3)?.map((p) => p.rev)).toEqual([4]);
  });

  it("offers the caller's profiles on the project, and never drops the current one", () => {
    const enrolled = ["default", "research", "finance"].map((name) => ({
      name,
      is_default: name === "default",
      description: "",
    }));
    expect(pickerProfiles(enrolled, ["research", "finance"], "research").map((p) => p.name)).toEqual([
      "research",
      "finance",
    ]);
    expect(pickerProfiles(enrolled, [], "default").map((p) => p.name)).toEqual([
      "default",
      "research",
      "finance",
    ]);
    expect(pickerProfiles(enrolled, ["research"], "finance").map((p) => p.name)).toEqual([
      "research",
      "finance",
    ]);
  });

  it("labels every member's turn and counts their turns and notes as missed", () => {
    const group: ProjectChatTimeline = {
      me: "leo",
      can_post: true,
      sessions: [{ profile: "research", session_id: "s-leo" }],
      messages: [
        { ...turn("research", "user", "Find sources", 10), session_id: "s-leo", person: "leo", person_name: "Leo" },
        { ...turn("research", "assistant", "Found three", 11), session_id: "s-leo", person: "leo", person_name: "Leo" },
        { ...turn("research", "user", "Which?", 20), session_id: "s-ada", person: "ada", person_name: "Ada" },
        { ...turn("research", "assistant", "The second", 21), session_id: "s-ada", person: "ada", person_name: "Ada" },
        {
          id: "m7",
          role: "user",
          content: "Check FX",
          timestamp: 22,
          profile: null,
          session_id: null,
          person: "ada",
          person_name: "Ada",
          member_only: true,
        },
      ],
      truncated: false,
      proposals: [],
      last_profile: "research",
    };
    const rows = timelineMessages(group);
    expect(rows.map((m) => m.personName)).toEqual(["Leo", "Leo", "Ada", "Ada", "Ada"]);
    expect(rows[4]).toMatchObject({ memberOnly: true, clientKey: "m7" });
    expect(rows[4].profile).toBeUndefined();
    expect(rows[4].id).toBeUndefined();
    // Leo's research conversation missed Ada's two turns and her note; the
    // same profile's turns in Ada's conversation are not his own.
    expect(missedCount(rows, "research", "leo")).toBe(3);
    expect(missedCount(rows, "research", "ada")).toBe(1);
    expect(missedCount(rows, "finance", "leo")).toBe(5);
  });

  it("keeps an earlier private chat out of the caller's own turns and the missed count", () => {
    const rows = timelineMessages({
      me: "leo",
      sessions: [],
      messages: [
        { ...turn("research", "user", "Old draft", 5), session_id: "s-old", person: "leo", private: true },
        { ...turn("research", "assistant", "Old reply", 6), session_id: "s-old", person: "leo", private: true },
        { ...turn("finance", "user", "New", 10), session_id: "s-ada", person: "ada" },
      ],
      truncated: false,
      proposals: [],
      last_profile: null,
    });
    expect(rows[0].privateHistory).toBe(true);
    expect(isOwnTurn(rows[0], "research", "leo")).toBe(false);
    expect(missedCount(rows, "research", "leo")).toBe(1);
  });
});
