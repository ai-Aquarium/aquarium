"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { RefBadge } from "@/components/refs/RefBadge";
import { channelOf, senderOf } from "@/lib/suggested-tasks/channels";
import type { IncomingItem, ProjectDetail, TodoProject, TodoStage } from "@/types";

import { ChannelTag } from "./ChannelTag";

const CARD = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3";

interface LinkedTodo {
  id: string;
  ref: string | null;
  title: string;
  stage: TodoStage;
  project: TodoProject | null;
}

function useJson<T>(url: string | null): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);
  return data;
}

const STAGE_TEXT: Record<TodoStage, string> = {
  staged: "suggested",
  open: "suggested",
  working: "working",
  review: "in review",
  done: "closed",
  dismissed: "dismissed",
};

/**
 * "Started from": the message a task was started from (its `arrival` link)
 * and the system to-do it is (its `todo` link, which closes when the task is
 * done). Renders nothing for a task started any other way.
 */
export function TaskSource({ project }: { project: ProjectDetail }) {
  const arrival = project.links?.arrival?.[0] ?? null;
  const todoLink = project.links?.todo?.[0] ?? null;
  const message = useJson<IncomingItem>(arrival ? `/api/incomings/${encodeURIComponent(arrival.ref)}` : null);
  const todo = useJson<LinkedTodo>(todoLink ? `/api/suggested-tasks/${encodeURIComponent(todoLink.ref)}` : null);
  if (!arrival && !todoLink) return null;
  const sender = message ? senderOf({ ...message, ref: message.ref ?? null }) : "";
  const body = (message?.body ?? "").trim();

  return (
    <section data-component="TaskSource" aria-label="Started from" className={`${CARD} flex flex-col gap-2 text-sm`}>
      <h2 className="text-sm font-semibold">Started from</h2>
      {arrival ? (
        <div data-component="TaskSourceMessage" className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {message ? <ChannelTag channel={channelOf(message)} /> : null}
            <RefBadge value={message?.ref} />
          </div>
          <p className="font-medium [overflow-wrap:anywhere]">
            {message?.subject?.trim() || arrival.label || "Source message"}
          </p>
          {sender ? (
            <p className="text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">From {sender}</p>
          ) : null}
          {body ? (
            <blockquote className="line-clamp-6 whitespace-pre-wrap border-l-2 border-[var(--color-border)] pl-2 text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">
              {body}
            </blockquote>
          ) : null}
          <Link
            href={`/inbox/${encodeURIComponent(arrival.ref)}`}
            className="inline-flex min-h-9 w-fit items-center text-xs text-[var(--color-accent)]"
          >
            Open message
          </Link>
        </div>
      ) : null}
      {todoLink ? (
        <p data-component="TaskSourceTodo" className="text-xs text-[var(--color-muted)]">
          Suggested task <RefBadge value={todo?.ref} />
          {todo ? ` · ${STAGE_TEXT[todo.stage] ?? todo.stage}` : ""}. It closes when this task is done.
        </p>
      ) : null}
    </section>
  );
}
