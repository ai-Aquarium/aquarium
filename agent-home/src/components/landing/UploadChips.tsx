"use client";

import { useId, useRef, useState } from "react";

import { PaperclipIcon, RefreshIcon, XIcon } from "@/components/ui/icons";

import type { LandingUpload } from "./useLandingUploads";

const MB = 1024 * 1024;

function trim(n: number): string {
  return String(Number(n.toFixed(1)));
}

/** "48 KB", "5 MB", "1.2 GB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * MB) return `${trim(bytes / MB)} MB`;
  return `${trim(bytes / (1024 * MB))} GB`;
}

/** "3.1 of 5 MB": the sent part in the total's unit. */
export function progressText(loaded: number, total: number): string {
  const [unit, div] = total < MB ? ["KB", 1024] : total < 1024 * MB ? ["MB", MB] : ["GB", 1024 * MB];
  const done = div === 1024 ? String(Math.round(loaded / div)) : trim(loaded / div);
  const all = div === 1024 ? String(Math.max(1, Math.round(total / div))) : trim(total / div);
  return `${done} of ${all} ${unit}`;
}

const BADGES: Record<string, string> = {
  xlsx: "XLS",
  xlsm: "XLS",
  docx: "DOC",
  pptx: "PPT",
  jpeg: "JPG",
  markdown: "MD",
};

/** The file-type badge: XLS, PDF, DOC, PNG… from the extension. */
export function fileBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!ext) return "FILE";
  return BADGES[ext] ?? ext.slice(0, 4).toUpperCase();
}

const PILL =
  "inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-fg)] hover:bg-[var(--color-surface)] disabled:opacity-40";
const ICON_BUTTON =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] disabled:opacity-40 disabled:hover:bg-transparent";

function Chip({
  item,
  locked,
  onCancel,
  onRemove,
  onRetry,
}: {
  item: LandingUpload;
  locked: boolean;
  onCancel: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const failed = item.status === "failed";
  const inFlight = item.status === "uploading" || item.status === "queued";
  const pct = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0;
  return (
    <li
      data-component="UploadChip"
      data-status={item.status}
      className={`flex w-full min-w-0 items-center gap-2.5 rounded-[var(--radius-lg)] border bg-[var(--color-surface-2)] py-2 pl-2 pr-2 sm:w-auto sm:max-w-full ${
        failed ? "border-[var(--color-danger)]" : "border-transparent"
      }`}
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)] text-[10px] font-semibold tracking-wide text-[var(--color-fg)]"
      >
        {fileBadge(item.name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium text-[var(--color-fg)]">{item.name}</span>
        {inFlight ? (
          <>
            <span className="flex items-center gap-2">
              <span
                role="progressbar"
                aria-label={`Uploading ${item.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.status === "uploading" ? pct : 0}
                className="h-1 w-full min-w-16 overflow-hidden rounded-full bg-[var(--color-border)] sm:w-36"
              >
                <span
                  className="block h-full rounded-full bg-[var(--color-accent)] transition-[width]"
                  style={{ width: `${item.status === "uploading" ? pct : 0}%` }}
                />
              </span>
              <span
                className={`shrink-0 text-xs tabular-nums ${
                  item.status === "uploading" ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"
                }`}
              >
                {item.status === "uploading" ? `${pct}%` : "Queued"}
              </span>
            </span>
            <span className="text-xs tabular-nums text-[var(--color-muted)]">
              {item.status === "uploading" ? progressText(item.loaded, item.total) : "Waiting to upload…"}
            </span>
          </>
        ) : (
          <span
            className={`truncate text-xs ${failed ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}
            title={failed ? item.error : undefined}
          >
            {failed ? item.error : formatSize(item.size)}
          </span>
        )}
      </span>
      {inFlight ? (
        <button type="button" aria-label={`Cancel upload of ${item.name}`} disabled={locked} onClick={onCancel} className={PILL}>
          <XIcon size={12} />
          Cancel
        </button>
      ) : (
        <>
          {failed && item.retryable ? (
            <button type="button" aria-label={`Retry ${item.name}`} disabled={locked} onClick={onRetry} className={PILL}>
              <RefreshIcon size={12} />
              Retry
            </button>
          ) : null}
          <button type="button" aria-label={`Remove ${item.name}`} disabled={locked} onClick={onRemove} className={ICON_BUTTON}>
            <XIcon size={14} />
          </button>
        </>
      )}
    </li>
  );
}

/** One chip per picked file, above the message box. */
export function UploadChips({
  items,
  locked,
  onCancel,
  onRemove,
  onRetry,
}: {
  items: LandingUpload[];
  locked: boolean;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul data-component="UploadChips" aria-label="Attached files" className="mb-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {items.map((item) => (
        <Chip
          key={item.id}
          item={item}
          locked={locked}
          onCancel={() => onCancel(item.id)}
          onRemove={() => onRemove(item.id)}
          onRetry={() => onRetry(item.id)}
        />
      ))}
    </ul>
  );
}

/**
 * The paperclip beside the profile picker. Hover or focus shows what it does;
 * on a box without file storage it stays visible but greyed out, and the
 * same tip (also on tap) says why.
 */
export function AttachButton({
  enabled,
  locked,
  onFiles,
}: {
  /** File storage is set up on this box. */
  enabled: boolean;
  /** The chat is starting: no new files. */
  locked: boolean;
  onFiles: (files: File[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const tipId = useId();
  const off = !enabled;
  return (
    <span data-component="AttachButton" className="group relative inline-flex">
      {enabled ? (
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="landing-file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) onFiles(files);
          }}
        />
      ) : null}
      <button
        type="button"
        aria-label={off ? "Attach files (file uploads are off)" : "Attach files"}
        aria-describedby={tipId}
        aria-disabled={off || undefined}
        disabled={locked}
        onClick={() => (off ? setTipOpen((v) => !v) : fileRef.current?.click())}
        onBlur={() => setTipOpen(false)}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] disabled:opacity-40 ${
          off ? "cursor-not-allowed opacity-40" : "hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]"
        }`}
      >
        <PaperclipIcon size={16} />
      </button>
      <span
        id={tipId}
        role="tooltip"
        data-open={tipOpen || undefined}
        className={`pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-64 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-left text-xs shadow-lg transition-opacity sm:left-1/2 sm:-translate-x-1/2 ${
          tipOpen ? "visible opacity-100" : "invisible opacity-0"
        } group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100`}
      >
        <span className="block font-medium text-[var(--color-fg)]">{off ? "File uploads are off" : "Attach files"}</span>
        <span className="mt-1 block text-[var(--color-muted)]">
          {off
            ? "File storage isn't set up on this box yet. Ask the box owner to set it up."
            : "Images, PDF, Word, Excel and more. They go with your first message."}
        </span>
      </span>
    </span>
  );
}
