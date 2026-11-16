// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { TodoDetailView } from "@/components/todos/TodoDetailView";
import type { TodoDetail } from "@/types";

const TODO: TodoDetail = {
  id: "tsk_1",
  owner_user_id: "leo_owner",
  visibility: "private:leo_owner",
  title: "Pay supplier invoice INV-2291",
  description: "",
  stage: "open",
  status: "pending",
  priority: "high",
  origin: "triage",
  current_state: "captured",
  trigger_state: "captured",
  completion_state: "done",
  due_at: null,
  source_kind: "email",
  source_ref: null,
  source_note: null,
  notified_at: null,
  snoozed_until: null,
  closed_at: null,
  outcome: null,
  work_result: null,
  routing_source_id: "src-mail",
  routing_batch_id: "b-1",
  created_at: "2026-11-16T10:42:00Z",
  updated_at: null,
  history: [],
  source: null,
};

afterEach(cleanup);

describe("TodoDetailView triage provenance (FG-03 P7)", () => {
  it("shows who triaged it and the Why this profile? link", () => {
    render(<TodoDetailView todo={TODO} profile="CFO" />);
    expect(screen.getByTestId("todo-provenance").textContent).toMatch(/^triaged by CFO · \d\d:\d\d/);
    expect(screen.getByRole("button", { name: "Why this profile?" })).toBeTruthy();
  });

  it("hides the link when the to-do carries no routing info", () => {
    render(<TodoDetailView todo={{ ...TODO, routing_source_id: null, routing_batch_id: null }} profile="CFO" />);
    expect(screen.getByTestId("todo-provenance")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Why this profile?" })).toBeNull();
  });

  it("has no provenance line for a to-do that triage didn't raise", () => {
    render(<TodoDetailView todo={{ ...TODO, origin: "user" }} profile="CFO" />);
    expect(screen.queryByTestId("todo-provenance")).toBeNull();
    expect(screen.queryByRole("button", { name: "Why this profile?" })).toBeNull();
  });
});
