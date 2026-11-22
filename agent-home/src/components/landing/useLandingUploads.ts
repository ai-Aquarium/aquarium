"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { deleteChatUpload, uploadChatFile, type ChatUpload } from "@/lib/chat/upload-chat-file";
import { formatUploadLimit } from "@/lib/chat/upload-limit";
import { uploadLimitBytes } from "@/lib/chat/upload-limit-client";
import type { ChatAttachment } from "@/types";

/** Smallest limit Settings → Uploads allows: smaller files skip the lookup. */
const MIN_LIMIT_BYTES = 1024 * 1024;

export type UploadStatus = "queued" | "uploading" | "done" | "failed";

export interface LandingUpload {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  loaded: number;
  total: number;
  attachment?: ChatAttachment;
  error?: string;
  /** Failed for a reason another try can fix (not "too big"). */
  retryable?: boolean;
  file: File;
}

/**
 * The landing composer's attachments: files upload one after another, each
 * can be cancelled at any time (its server copy is deleted), and new picks
 * join the queue while others run. Only finished files go with the message.
 */
export function useLandingUploads() {
  const [items, setItems] = useState<LandingUpload[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const itemsRef = useRef<LandingUpload[]>([]);
  const handles = useRef(new Map<string, ChatUpload>());
  const nextId = useRef(0);

  const update = useCallback((fn: (prev: LandingUpload[]) => LandingUpload[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);
  const patch = useCallback(
    (id: string, changes: Partial<LandingUpload>) =>
      update((prev) => prev.map((i) => (i.id === id ? { ...i, ...changes } : i))),
    [update],
  );

  // The finished upload's callback starts the next one through this ref.
  const pumpRef = useRef<() => void>(() => {});
  const pump = useCallback(() => {
    if (itemsRef.current.some((i) => i.status === "uploading")) return;
    const next = itemsRef.current.find((i) => i.status === "queued");
    if (!next) return;
    patch(next.id, { status: "uploading", loaded: 0, total: next.size });
    const handle = uploadChatFile(next.file, (loaded, total) => patch(next.id, { loaded, total }));
    handles.current.set(next.id, handle);
    void handle.done.then((result) => {
      handles.current.delete(next.id);
      if (!itemsRef.current.some((i) => i.id === next.id)) return pumpRef.current();
      if (result.ok) {
        patch(next.id, { status: "done", attachment: result.attachment, loaded: next.size });
      } else if (!result.cancelled) {
        patch(next.id, { status: "failed", error: result.error, retryable: true });
      }
      pumpRef.current();
    });
  }, [patch]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // Leaving the page stops whatever is still on the wire.
  useEffect(() => {
    const live = handles.current;
    return () => {
      for (const h of live.values()) h.cancel();
      live.clear();
    };
  }, []);

  const add = useCallback(
    async (files: File[]) => {
      setNote(null);
      const limit = files.some((f) => f.size > MIN_LIMIT_BYTES) ? await uploadLimitBytes() : null;
      const added = files.map((file): LandingUpload => {
        const tooBig = limit !== null && file.size > limit;
        nextId.current += 1;
        return {
          id: `u${nextId.current}`,
          name: file.name,
          size: file.size,
          status: tooBig ? "failed" : "queued",
          loaded: 0,
          total: file.size,
          error: tooBig ? `Over the ${formatUploadLimit(limit)} upload limit` : undefined,
          retryable: false,
          file,
        };
      });
      update((prev) => [...prev, ...added]);
      pump();
    },
    [pump, update],
  );

  /** Stop a queued or running upload; nothing of it is kept. */
  const cancel = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return;
      handles.current.get(id)?.cancel();
      handles.current.delete(id);
      if (item.attachment) void deleteChatUpload(item.attachment.path);
      update((prev) => prev.filter((i) => i.id !== id));
      setNote(`Upload of ${item.name} cancelled. Nothing was kept.`);
      pump();
    },
    [pump, update],
  );

  /** Take a finished or failed file out of the message. */
  const remove = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return;
      if (item.attachment) void deleteChatUpload(item.attachment.path);
      update((prev) => prev.filter((i) => i.id !== id));
    },
    [update],
  );

  const retry = useCallback(
    (id: string) => {
      patch(id, { status: "queued", error: undefined, loaded: 0 });
      pump();
    },
    [patch, pump],
  );

  const attachments = items.flatMap((i) => (i.status === "done" && i.attachment ? [i.attachment] : []));
  return {
    items,
    note,
    add,
    cancel,
    remove,
    retry,
    attachments,
    busy: items.some((i) => i.status === "queued" || i.status === "uploading"),
    failed: items.filter((i) => i.status === "failed").length,
  };
}
