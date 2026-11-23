// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatFile } from "@/components/chat/ChatFile";
import { ChatMedia } from "@/components/chat/ChatMedia";
import { MediaProjectContext } from "@/components/chat/MediaProject";

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observers: Array<{ cb: IOCallback; options?: IntersectionObserverInit }> = [];
class FakeIntersectionObserver {
  constructor(cb: IOCallback, options?: IntersectionObserverInit) {
    observers.push({ cb, options });
  }
  observe() {}
  disconnect() {}
}

const fetchMock = vi.fn();

describe("ChatMedia", () => {
  beforeEach(() => {
    observers = [];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://signed.test/a.png" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("waits until the element is near the viewport before signing", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(<ChatMedia path="mia_member/home_2/u1-a.png" alt="shot" />);
    expect(screen.getByText("Loading shot…")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(observers[0].options?.rootMargin).toBe("400px");

    act(() => observers[0].cb([{ isIntersecting: false }]));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => observers[0].cb([{ isIntersecting: true }]));
    await waitFor(() =>
      expect(screen.getByRole("img").getAttribute("src")).toBe(
        "https://signed.test/a.png",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/chat/media?path=");
  });

  it("asks as the project inside a project chat, for images and files", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(
      <MediaProjectContext.Provider value="sales">
        <ChatMedia path="leo_owner/home_1/u1-a.png" alt="shot" />
        <ChatFile path="leo_owner/home_1/u2-b.pdf" name="b.pdf" />
      </MediaProjectContext.Provider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const [url] of fetchMock.mock.calls) expect(String(url)).toContain("&project=sales");
  });

  it("loads immediately when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<ChatMedia path="mia_member/home_2/u1-a.png" alt="shot" />);
    await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable state when signing fails", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    render(<ChatMedia path="mia_member/home_2/u1-a.png" alt="shot" />);
    await waitFor(() => expect(screen.getByText("shot — unavailable")).toBeTruthy());
  });
});
