// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSuggestedTasks } from "./useSuggestedTasks";

const row = (id: string) => ({ channel: "email", source: null, todo: { id, title: id } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSuggestedTasks", () => {
  it("keeps the cursor and appends the next page", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      Response.json(
        url.includes("cursor=c2")
          ? { items: [row("b"), row("c")], next_cursor: null, profile: "default" }
          : { items: [row("a"), row("b")], next_cursor: "c2", profile: "default" },
      ),
    );
    vi.stubGlobal("fetch", fetchFn);
    const { result } = renderHook(() => useSuggestedTasks());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.nextCursor).toBe("c2");
    expect(result.current.profile).toBe("default");
    await act(() => result.current.loadMore!());
    expect(result.current.items.map((t) => t.todo.id)).toEqual(["a", "b", "c"]);
    expect(result.current.nextCursor).toBeNull();
    expect(fetchFn.mock.calls[1][0]).toBe("/api/suggested-tasks?cursor=c2");
  });
});
