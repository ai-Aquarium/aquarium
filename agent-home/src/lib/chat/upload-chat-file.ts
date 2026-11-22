/**
 * One chat attachment upload with real progress and a Cancel that works at
 * any time (the landing composer). POSTs to `/api/chat/upload` over XHR —
 * `fetch` has no upload progress — and parses failures the way the chat
 * composer does.
 */
import { parseJsonObject, uploadFailureReason } from "@/lib/chat/upload-error";
import type { ChatAttachment } from "@/types";

export type ChatUploadResult =
  | { ok: true; attachment: ChatAttachment }
  | { ok: false; cancelled: boolean; error: string };

export interface ChatUpload {
  done: Promise<ChatUploadResult>;
  /** Stop the upload. Bytes already stored are deleted; resolves `cancelled`. */
  cancel: () => void;
}

export const NO_CONNECTION = "Upload failed: no connection";

function outcome(file: File, status: number, text: string): ChatUploadResult {
  const body = status >= 200 && status < 300 ? parseJsonObject<ChatAttachment>(text) : null;
  if (body?.path) {
    return {
      ok: true,
      attachment: {
        path: body.path,
        name: body.name || file.name,
        content_type: body.content_type || file.type,
        size: typeof body.size === "number" ? body.size : file.size,
      },
    };
  }
  const reason = uploadFailureReason(status, text);
  return {
    ok: false,
    cancelled: false,
    error: reason.startsWith("Upload failed") ? reason : `Upload failed: ${reason}`,
  };
}

/** Delete one of the caller's own unsent uploads; best effort. */
export function deleteChatUpload(path: string): Promise<void> {
  return fetch("/api/chat/upload", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }).then(
    () => undefined,
    () => undefined,
  );
}

export function uploadChatFile(
  file: File,
  onProgress: (loaded: number, total: number) => void,
): ChatUpload {
  const xhr = new XMLHttpRequest();
  let cancelled = false;
  let sent = false;
  let settle: (r: ChatUploadResult) => void = () => {};
  const done = new Promise<ChatUploadResult>((resolve) => {
    settle = resolve;
  });
  const cancelledResult: ChatUploadResult = { ok: false, cancelled: true, error: "" };

  xhr.open("POST", "/api/chat/upload");
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable || e.total <= 0) return;
    onProgress(e.loaded, e.total);
    if (e.loaded >= e.total) sent = true;
  };
  xhr.upload.onload = () => {
    sent = true;
  };
  xhr.onload = () => {
    const result = outcome(file, xhr.status, xhr.responseText);
    if (!cancelled) {
      settle(result);
      return;
    }
    // Cancelled after the last byte left: the server stored it anyway.
    if (result.ok) void deleteChatUpload(result.attachment.path);
    settle(cancelledResult);
  };
  xhr.onerror = () => settle(cancelled ? cancelledResult : { ok: false, cancelled: false, error: NO_CONNECTION });
  xhr.onabort = () => settle(cancelledResult);

  const form = new FormData();
  form.set("file", file);
  xhr.send(form);

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      // Mid-body, aborting leaves the server a broken stream it never stores.
      // Once every byte is sent the server may already be storing it, so wait
      // for its answer and delete what it kept (onload above).
      if (!sent) xhr.abort();
      else settle(cancelledResult);
    },
  };
}
