import type { RoutingDecision } from "@/types";

/** A realistic routing decision for tests and the screenshot harness (Figma 4a). */
export function decision(over: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    decision_id: 7,
    batch_id: "b-1",
    source_id: "src-mail",
    channel: "email",
    owner_user_id: "leo",
    choices: [
      { profile: "CFO", selected: true, reason: "Supplier invoice INV-2291 due Friday." },
      { profile: "CMO", selected: false, reason: "No campaign, press or agency content." },
    ],
    selected: ["CFO"],
    model: "gpt-4o-mini",
    attempts: 1,
    fallback: false,
    error: null,
    decided_at: "2026-11-16T10:42:00Z",
    message_count: 3,
    first_sender: "john@acme.com",
    ...over,
  };
}
