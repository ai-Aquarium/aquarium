import { describe, expect, it } from "vitest";

import type { SuggestedTaskSource, Todo } from "@/types";

import { arrivalKeyOf, channelLabel, channelOf, isSuggested, startRequestText, tomorrowMorning } from "./channels";

const todo = (extra: Partial<Todo> = {}) =>
  ({ id: "t1", title: "Reply to Ada", description: "", stage: "open", ...extra }) as Todo;
const source = (extra: Partial<SuggestedTaskSource> = {}): SuggestedTaskSource => ({
  id: "m1",
  surface: "email",
  account_id: null,
  sender_name: "Ada Wong",
  sender_id: "ada@x",
  subject: "Tender",
  body: "Can we still   submit by Friday?",
  occurred_at: null,
  ...extra,
});

describe("suggested-task helpers", () => {
  it("tags by the source message's surface, else other", () => {
    expect(channelOf(source({ surface: "WhatsApp" }))).toBe("whatsapp");
    expect(channelOf(null)).toBe("other");
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
    expect(channelLabel("line_works")).toBe("Line works");
  });

  it("builds the same arrival key as needs_you.arrival_key", () => {
    expect(arrivalKeyOf(source({ account_id: "sales@acme.hk", external_id: "<a:b>!" }))).toBe(
      "arrival:email:sales%40acme.hk:%3Ca%3Ab%3E%21",
    );
    expect(arrivalKeyOf(source())).toBeNull();
  });

  it("only open and staged to-dos are suggestions", () => {
    expect(isSuggested(todo({ stage: "staged" }))).toBe(true);
    expect(isSuggested(todo({ stage: "working" }))).toBe(false);
  });

  it("prefills the ask, then who sent what", () => {
    expect(startRequestText({ todo: todo({ description: "Ada asks about Friday." }), source: source() })).toBe(
      'Reply to Ada\n\nAda asks about Friday.\n\nSource: Ada Wong — "Can we still submit by Friday?"',
    );
    expect(startRequestText({ todo: todo({ description: "Reply to Ada" }), source: null })).toBe("Reply to Ada");
  });

  it("snoozes to 09:00 the next day", () => {
    const next = tomorrowMorning(new Date(2026, 10, 17, 22, 30));
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([18, 9, 0]);
  });
});
