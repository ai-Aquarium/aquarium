// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/chat/session-list-fetch", () => ({ fetchSessionList: async () => null }));

import { __resetUploadLimit } from "@/lib/chat/upload-limit-client";
import { takeHandOffAttachments } from "@/lib/chat/pending-attachments";

import { LandingComposer } from "./LandingComposer";
import { chatHandOffUrl } from "./startChat";
import { fileBadge, formatSize, progressText } from "./UploadChips";

/** A controllable XMLHttpRequest: tests push progress and answers by hand. */
class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((e: ProgressEvent) => void) | null; onload: (() => void) | null } = {
    onprogress: null,
    onload: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  method = "";
  url = "";
  body: FormData | null = null;
  aborted = false;
  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

const MB = 1024 * 1024;
function file(name: string, size: number): File {
  const f = new File(["x"], name, { type: "application/pdf" });
  Object.defineProperty(f, "size", { value: size });
  return f;
}
const profiles = [{ name: "default", is_default: true }] as never;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
  url === "/api/settings/uploads"
    ? new Response(JSON.stringify({ max_bytes: 100 * MB }), { status: 200 })
    : new Response("{}", { status: 200 }),
);

function pick(...files: File[]) {
  fireEvent.change(screen.getByTestId("landing-file-input"), { target: { files } });
}
function chip(name: string) {
  return screen.getByText(name).closest("li") as HTMLElement;
}
function sendButton() {
  return screen.getByRole("button", { name: /Start chat|Starting chat/ }) as HTMLButtonElement;
}
async function settle(fn: () => void) {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
}
function done(x: FakeXhr, name: string, size: number) {
  return settle(() => x.respond(200, { path: `u/p/${name}`, name, content_type: "application/pdf", size }));
}

describe("LandingComposer uploads", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    push.mockReset();
    fetchMock.mockClear();
    __resetUploadLimit();
    sessionStorage.clear();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows progress, uploads one file after another and locks Send meanwhile", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" storageEnabled />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "compare" } });
    pick(file("a.pdf", 5 * MB), file("b.docx", 2 * MB));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(FakeXhr.all[0].url).toBe("/api/chat/upload");
    expect(within(chip("b.docx")).getByText("Queued")).toBeTruthy();
    expect(within(chip("b.docx")).getByText("Waiting to upload…")).toBeTruthy();

    act(() => FakeXhr.all[0].progress(3.1 * MB, 5 * MB));
    expect(within(chip("a.pdf")).getByText("62%")).toBeTruthy();
    expect(within(chip("a.pdf")).getByText("3.1 of 5 MB")).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId("landing-send-hint").textContent).toBe("Send unlocks when uploads finish");
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(push).not.toHaveBeenCalled();

    await done(FakeXhr.all[0], "a.pdf", 5 * MB);
    expect(FakeXhr.all).toHaveLength(2);
    await done(FakeXhr.all[1], "b.docx", 2 * MB);
    expect(sendButton().disabled).toBe(false);
    expect(screen.getByTestId("landing-send-hint").textContent).toBe("Enter to send · 2 files attached");
    expect(within(chip("a.pdf")).getByText("5 MB")).toBeTruthy();
    expect(within(chip("a.pdf")).getByRole("button", { name: "Remove a.pdf" })).toBeTruthy();
  });

  it("cancel aborts the running upload, deletes nothing-kept copies and starts the next", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" storageEnabled />);
    pick(file("a.pdf", 5 * MB), file("b.pdf", 5 * MB));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    act(() => FakeXhr.all[0].progress(MB, 5 * MB));
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of a.pdf" }));
    expect(FakeXhr.all[0].aborted).toBe(true);
    expect(screen.queryByText("a.pdf")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Upload of a.pdf cancelled. Nothing was kept.");
    expect(FakeXhr.all).toHaveLength(2);

    // Every byte sent, answer pending: Cancel waits for it and deletes the copy.
    act(() => FakeXhr.all[1].progress(5 * MB, 5 * MB));
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of b.pdf" }));
    expect(FakeXhr.all[1].aborted).toBe(false);
    await done(FakeXhr.all[1], "b.pdf", 5 * MB);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/upload",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ path: "u/p/b.pdf" }) }),
      ),
    );
    expect(screen.queryByText("b.pdf")).toBeNull();
  });

  it("cancels a queued file without uploading it, and removing a finished one deletes it", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" storageEnabled />);
    pick(file("a.pdf", 5 * MB));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    // The paperclip stays usable while an upload runs: the new file queues.
    pick(file("q.pdf", 5 * MB));
    await screen.findByText("q.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of q.pdf" }));
    await done(FakeXhr.all[0], "a.pdf", 5 * MB);
    expect(FakeXhr.all).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove a.pdf" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/chat/upload", expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("refuses files over the limit, offers Retry on failure and never sends failed files", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" storageEnabled />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
    pick(file("big.mov", 200 * MB), file("a.pdf", 5 * MB), file("b.pdf", 5 * MB));
    expect(await screen.findByText("Over the 100 MB upload limit")).toBeTruthy();
    expect(within(chip("big.mov")).queryByRole("button", { name: /Retry/ })).toBeNull();
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    await settle(() => FakeXhr.all[0].fail());
    expect(within(chip("a.pdf")).getByText("Upload failed: no connection")).toBeTruthy();
    await settle(() => FakeXhr.all[1].respond(413, { error: "too_large", detail: "Too big for the box." }));
    expect(within(chip("b.pdf")).getByText("Upload failed: Too big for the box. (HTTP 413, too_large)")).toBeTruthy();
    expect(screen.getByTestId("landing-send-hint").textContent).toBe("Failed files won't be sent");

    fireEvent.click(within(chip("a.pdf")).getByRole("button", { name: "Retry a.pdf" }));
    expect(FakeXhr.all).toHaveLength(3);
    await done(FakeXhr.all[2], "a.pdf", 5 * MB);
    fireEvent.click(sendButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith(chatHandOffUrl("go")));
    expect(takeHandOffAttachments("go").map((a) => a.name)).toEqual(["a.pdf"]);
  });

  it("starts the chat once, locks everything and hands the files over after a profile switch", async () => {
    const twoProfiles = [
      { name: "default", is_default: true },
      { name: "work", is_default: false },
    ] as never;
    let release: () => void = () => {};
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/session/profile") {
        await new Promise<void>((r) => (release = r));
      }
      return new Response("{}", { status: 200 });
    });
    render(<LandingComposer profiles={twoProfiles} currentProfile="default" storageEnabled />);
    fireEvent.change(screen.getByLabelText("Profile for the new chat"), { target: { value: "work" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    pick(file("a.pdf", 1000));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    await done(FakeXhr.all[0], "a.pdf", 1000);

    fireEvent.click(sendButton());
    fireEvent.click(sendButton());
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await screen.findByRole("button", { name: "Starting chat" });
    expect(fetchMock.mock.calls.filter(([u]) => u === "/api/session/profile")).toHaveLength(1);
    expect(screen.getByTestId("landing-send-hint").textContent).toBe("Starting chat…");
    expect((screen.getByRole("button", { name: "Remove a.pdf" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Profile for the new chat") as HTMLSelectElement).disabled).toBe(true);

    await act(async () => release());
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(takeHandOffAttachments("hi")).toEqual([
      { path: "u/p/a.pdf", name: "a.pdf", content_type: "application/pdf", size: 1000 },
    ]);
  });

  it("greys the paperclip out with an explanation when the box has no file storage", () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    const clip = screen.getByRole("button", { name: /Attach files/ });
    expect(clip.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("landing-file-input")).toBeNull();
    const tip = document.getElementById(clip.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(tip.textContent).toContain("File uploads are off");
    expect(tip.textContent).toContain("File storage isn't set up on this box yet. Ask the box owner to set it up.");
    fireEvent.click(clip);
    expect(tip.dataset.open).toBe("true");
  });

  it("explains the paperclip when storage is set up", () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" storageEnabled />);
    const clip = screen.getByRole("button", { name: "Attach files" });
    const tip = document.getElementById(clip.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(tip.textContent).toBe("Attach filesImages, PDF, Word, Excel and more. They go with your first message.");
  });

  it("formats sizes, progress and badges", () => {
    expect(formatSize(48 * 1024)).toBe("48 KB");
    expect(formatSize(5 * MB)).toBe("5 MB");
    expect(progressText(3.1 * MB, 5 * MB)).toBe("3.1 of 5 MB");
    expect(fileBadge("Q3 budget.xlsx")).toBe("XLS");
    expect(fileBadge("Contract notes.docx")).toBe("DOC");
    expect(fileBadge("Vendor contract.pdf")).toBe("PDF");
    expect(fileBadge("README")).toBe("FILE");
  });
});
