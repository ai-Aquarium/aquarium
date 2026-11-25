"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";

import { useProjectAction } from "@/components/projects/useProjectAction";
import { RefBadge } from "@/components/refs/RefBadge";
import { WhyThisProfile } from "@/components/sources/WhyThisProfile";
import { ChannelTag, SuggestedTag } from "@/components/suggested-tasks/ChannelTag";
import { StartTaskSheet } from "@/components/suggested-tasks/StartTaskSheet";
import { post } from "@/components/suggested-tasks/SuggestedTaskList";
import { announceSuggestedTasksChanged } from "@/components/suggested-tasks/useSuggestedTasks";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useNeedsYouText } from "@/lib/landing/needsYouText";
import { usePopover } from "@/components/landing/topbar/usePopover";
import { SNOOZE_OPTIONS, SUGGESTED_HINTS, channelOf, senderOf, snoozeUntil, type SnoozeOption } from "@/lib/suggested-tasks/channels";
import { useAction } from "@/lib/use-action";
import type { SuggestedTask, SuggestedTaskSource, TodoDetail } from "@/types";
import type { NeedsYouAction, NeedsYouEntry } from "@/types/landing";

import { BUTTON, OneTapButton } from "./NeedsYouItem";
import { SEVERITY_TONE } from "./tone";

/** One row of the Details view: a Needs-you entry or a suggested-task card. */
export type NeedsYouDetailItem =
  | { key: string; kind: "entry"; entry: NeedsYouEntry }
  | { key: string; kind: "suggested"; task: SuggestedTask };

/** "Ask for changes" answered `todoId` from the item keyed `answeredKey`. */
export interface DraftRevision {
  note: string;
  answeredKey: string;
}

const SECTION = "flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3";
const H3 = "text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";
const ROW = "grid grid-cols-[96px_1fr] gap-2 text-[13px] leading-[18px]";
const LINK = "text-[13px] font-medium text-[var(--color-accent)] hover:underline";
const SECONDARY = "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)]";

/** Same-origin BFF paths only, as on the card. */
function isBffPath(endpoint: string | undefined): endpoint is string {
  return typeof endpoint === "string" && /^\/api\/[^/]/.test(endpoint) && !endpoint.includes("..");
}

function useJson<T>(url: string | null): T | null {
  const [data, setData] = useState<{ url: string; body: T } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
      .then((body) => {
        if (!cancelled && body) setData({ url, body });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);
  return data && data.url === url ? data.body : null;
}

function when(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className={ROW}>
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** A reply to send: irreversible, answered with send / reject / free-text feedback. */
export function isReplyToSend(entry: NeedsYouEntry): boolean {
  return entry.source === "todo" && entry.severity === "approval" && (entry.actions ?? []).some((a) => a.id === "send");
}

function SourceSection({ source, inboxId }: { source: SuggestedTaskSource | null; inboxId?: string | null }) {
  const { t } = useNeedsYouText();
  if (!source) return null;
  const body = (source.body ?? "").trim();
  return (
    <section className={SECTION} data-testid="details-source">
      <h3 className={H3}>{t("detailsView.sections.source")}</h3>
      <dl className="flex flex-col gap-1">
        <Row label={t("detailsView.fields.channel")}>
          <ChannelTag channel={channelOf(source)} />
        </Row>
        <Row label={t("detailsView.fields.sender")}>{senderOf(source) || null}</Row>
        <Row label={t("detailsView.fields.subject")}>{source.subject?.trim() || null}</Row>
        <Row label={t("detailsView.fields.received")}>{when(source.occurred_at)}</Row>
      </dl>
      {body ? (
        <blockquote className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-2 text-[13px] leading-[18px] [overflow-wrap:anywhere]">
          {body}
        </blockquote>
      ) : null}
      {inboxId ? (
        <Link href={`/inbox/${encodeURIComponent(inboxId)}`} className={LINK}>
          {t("detailsView.links.inbox")}
        </Link>
      ) : null}
    </section>
  );
}

function arrivalOf(detail: TodoDetail | null): { source: SuggestedTaskSource | null; id: string | null } {
  const m = detail?.source;
  if (!m) return { source: null, id: null };
  return {
    id: m.id,
    source: {
      id: m.id,
      surface: m.surface,
      account_id: m.account_id ?? null,
      external_id: m.external_id ?? null,
      sender_id: m.sender_id,
      sender_name: m.sender_name,
      subject: m.subject,
      body: m.body,
      occurred_at: m.occurred_at,
    },
  };
}

function raisedBy(detail: TodoDetail | null): string | null {
  const first = detail?.history?.[0];
  if (!first?.actor) return null;
  const who = first.actor.replace(/^(user|skill|agent):/, "");
  const at = when(first.at);
  return at ? `${who} · ${at}` : who;
}

function WhySection({ why, detail, entry }: { why: string; detail: TodoDetail | null; entry?: NeedsYouEntry }) {
  const { t } = useNeedsYouText();
  const todo = detail;
  return (
    <section className={SECTION} data-testid="details-why">
      <h3 className={H3}>{t("detailsView.sections.why")}</h3>
      <p className="text-[13px] leading-[18px]">{why}</p>
      <dl className="flex flex-col gap-1">
        <Row label={t("detailsView.fields.priority")}>{todo?.priority ?? null}</Row>
        <Row label={t("detailsView.fields.due")}>{when(todo?.due_at)}</Row>
        <Row label={t("detailsView.fields.raisedBy")}>{raisedBy(detail)}</Row>
      </dl>
      {entry?.context.routing_source_id ? (
        <WhyThisProfile
          sourceId={entry.context.routing_source_id}
          batchId={entry.context.routing_batch_id}
          profile={entry.context.profile}
        />
      ) : null}
    </section>
  );
}

function DoesSection({ ids, labelOf }: { ids: string[]; labelOf: (id: string) => string }) {
  const { t } = useNeedsYouText();
  const rows = ids.filter((id) => t.has(`detailsView.does.${id}`));
  if (rows.length === 0) return null;
  return (
    <section className={SECTION} data-testid="details-does">
      <h3 className={H3}>{t("detailsView.sections.does")}</h3>
      <dl className="flex flex-col gap-1">
        {rows.map((id) => (
          <Row key={id} label={labelOf(id)}>
            {t(`detailsView.does.${id}`)}
          </Row>
        ))}
      </dl>
    </section>
  );
}

function LinkedSection({ entry, todo }: { entry?: NeedsYouEntry; todo?: { id: string; ref?: string | null } | null }) {
  const { t } = useNeedsYouText();
  const c = entry?.context ?? {};
  const links: { href: string; label: string }[] = [];
  if (todo) links.push({ href: `/todos/${encodeURIComponent(todo.id)}`, label: t("detailsView.links.todo", { ref: todo.ref ?? "" }).trim() });
  if (c.project_slug) {
    const slug = encodeURIComponent(c.project_slug);
    links.push({ href: `/projects/${slug}`, label: t("detailsView.links.project", { project: c.project_slug }) });
    if (c.run_no != null) links.push({ href: `/projects/${slug}/runs/${c.run_no}`, label: t("detailsView.links.run", { run: c.run_no }) });
    if (c.task_id) links.push({ href: `/projects/${slug}/cards/${encodeURIComponent(c.task_id)}`, label: t("detailsView.links.card", { card: c.task_id }) });
  }
  if (entry?.href && !links.some((l) => l.href === entry.href)) links.push({ href: entry.href, label: t("detailsView.links.page") });
  if (links.length === 0) return null;
  return (
    <section className={SECTION} data-testid="details-linked">
      <h3 className={H3}>{t("detailsView.sections.linked")}</h3>
      <ul className="flex flex-col gap-1">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={LINK}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A POST that can't be undone: a confirm step, then the request. */
function ConfirmButton({
  action,
  question,
  note,
  yes,
  tone,
  onDone,
}: {
  action: NeedsYouAction & { endpoint: string };
  question: string;
  note?: string;
  yes: string;
  tone: string;
  onDone: (data: Record<string, unknown> | null) => void;
}) {
  const text = useNeedsYouText();
  const act = useProjectAction();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" data-action={`details-${action.id}`} onClick={() => setAsking(true)} className={`${BUTTON} ${tone}`}>
        {text.action(action.label)}…
      </button>
    );
  }
  return (
    <div role="alertdialog" aria-label={question} data-testid="details-confirm" className="flex w-full flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <p className="text-[13px] font-medium leading-[18px]">{question}</p>
      {note ? <p className="text-[12px] leading-[16px] text-[var(--color-muted)]">{note}</p> : null}
      {act.error ? <InlineAlert tone="danger">{text.t("detailsView.failed", { error: act.error })}</InlineAlert> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-action={`details-${action.id}-confirm`}
          disabled={act.busy}
          onClick={async () => {
            const result = await act.run(action.endpoint, { method: "POST", body: action.body, skipRefresh: true });
            if (result?.ok) onDone(result.data);
          }}
          className={`${BUTTON} ${tone}`}
        >
          {act.busy ? <Spinner /> : null}
          {yes}
        </button>
        <button type="button" onClick={() => setAsking(false)} className={`${BUTTON} ${SECONDARY}`}>
          {text.t("detailsView.cancel")}
        </button>
      </div>
    </div>
  );
}

/** "Ask for changes": the note goes back as the answer, and the agent rewrites. */
function FeedbackBox({
  action,
  onSent,
  onCancel,
}: {
  action: NeedsYouAction & { endpoint: string };
  onSent: (note: string) => void;
  onCancel: () => void;
}) {
  const { t } = useNeedsYouText();
  const act = useProjectAction<{ action?: { type?: string; error?: string } }>();
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      data-testid="details-feedback"
      className="flex w-full flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const text = note.trim();
        if (!text) return setProblem(t("detailsView.noteRequired"));
        setProblem(null);
        const result = await act.run(action.endpoint, { method: "POST", body: { answer: text, feedback: true }, skipRefresh: true });
        if (!result?.ok) return;
        const outcome = result.data?.action;
        if (outcome && outcome.type !== "revision") {
          return setProblem(t("detailsView.failed", { error: outcome.error ?? outcome.type ?? "" }));
        }
        onSent(text);
      }}
    >
      <label htmlFor="details-feedback-note" className="text-[13px] font-medium">
        {t("detailsView.feedbackLabel")}
      </label>
      <textarea
        id="details-feedback-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder={t("detailsView.feedbackPlaceholder")}
        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[13px] leading-[18px]"
      />
      <p className="text-[12px] leading-[16px] text-[var(--color-muted)]">{t("detailsView.feedbackHint")}</p>
      {problem || act.error ? <InlineAlert tone="danger">{problem ?? t("detailsView.failed", { error: act.error ?? "" })}</InlineAlert> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" data-action="details-rewrite" disabled={act.busy} className={`${BUTTON} ${SEVERITY_TONE.approval.button}`}>
          {act.busy ? <Spinner /> : null}
          {t("detailsView.rewrite")}
        </button>
        <button type="button" onClick={onCancel} className={`${BUTTON} ${SECONDARY}`}>
          {t("detailsView.cancel")}
        </button>
      </div>
    </form>
  );
}

function EntryBody({
  item,
  revision,
}: {
  item: Extract<NeedsYouDetailItem, { kind: "entry" }>;
  revision: DraftRevision | null;
}) {
  const text = useNeedsYouText();
  const { t } = text;
  const entry = item.entry;
  const todoId = entry.context.todo_id ?? null;
  const detail = useJson<TodoDetail>(todoId ? `/api/todos/${encodeURIComponent(todoId)}` : null);
  const arrival = arrivalOf(detail);
  const reply = isReplyToSend(entry);
  const c = entry.context;
  const rewriting = !!revision && revision.answeredKey === item.key;
  const description = text.detail(entry);
  const why = reply ? t("detailsView.why.reply") : t(`detailsView.why.${entry.severity}`);

  return (
    <>
      {reply ? (
        <section className={SECTION} data-testid="details-draft">
          <h3 className={H3}>{t("detailsView.sections.draft")}</h3>
          {revision && !rewriting ? (
            <p data-testid="details-rewritten" className="text-[12px] leading-[16px] text-[var(--color-muted)]">
              {t("detailsView.rewritten", { note: revision.note })}
            </p>
          ) : null}
          <dl className="flex flex-col gap-1">
            <Row label={t("detailsView.fields.to")}>{c.reply_to ?? null}</Row>
            <Row label={t("detailsView.fields.from")}>{c.reply_account ?? null}</Row>
            <Row label={t("detailsView.fields.channel")}>{c.reply_channel ? <ChannelTag channel={c.reply_channel} /> : null}</Row>
            <Row label={t("detailsView.fields.subject")}>{c.reply_subject ?? null}</Row>
          </dl>
          {rewriting ? (
            <p data-testid="details-rewriting" className="flex items-center gap-2 text-[13px]">
              <Spinner /> {t("detailsView.rewriting")}
            </p>
          ) : description ? (
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-2 text-[13px] leading-[18px] [overflow-wrap:anywhere]">
              {description}
            </div>
          ) : null}
        </section>
      ) : description ? (
        <p className="whitespace-pre-wrap text-[13px] leading-[18px] [overflow-wrap:anywhere]" data-testid="details-description">
          {description}
        </p>
      ) : null}
      <SourceSection source={arrival.source} inboxId={arrival.id} />
      <WhySection why={why} detail={detail} entry={entry} />
      <DoesSection ids={(entry.actions ?? []).map((a) => a.id)} labelOf={(id) => text.action(entry.actions.find((a) => a.id === id)?.label ?? id)} />
      <LinkedSection entry={entry} todo={todoId ? { id: todoId, ref: detail?.ref } : null} />
    </>
  );
}

function EntryActions({
  item,
  rewriting,
  onActed,
  onRevise,
}: {
  item: Extract<NeedsYouDetailItem, { kind: "entry" }>;
  rewriting: boolean;
  onActed: (entry: NeedsYouEntry) => void;
  onRevise: (note: string) => void;
}) {
  const text = useNeedsYouText();
  const { t } = text;
  const entry = item.entry;
  const tone = SEVERITY_TONE[entry.severity] ?? SEVERITY_TONE.fyi;
  const [asking, setAsking] = useState(false);
  if (rewriting) return null;
  const posts = (entry.actions ?? []).filter((a): a is NeedsYouAction & { endpoint: string } => !a.href && isBffPath(a.endpoint));
  const links = (entry.actions ?? []).filter((a) => a.href);
  const revise = posts.find((a) => a.id === "revise");
  if (asking && revise) {
    return <FeedbackBox action={revise} onCancel={() => setAsking(false)} onSent={(note) => { setAsking(false); onRevise(note); }} />;
  }
  const c = entry.context;
  const sendQuestion = c.reply_to
    ? c.reply_account
      ? t("detailsView.confirmSend", { channel: c.reply_channel ?? "message", to: c.reply_to, from: c.reply_account })
      : t("detailsView.confirmSendTo", { channel: c.reply_channel ?? "message", to: c.reply_to })
    : null;
  return (
    <div className="flex w-full flex-wrap gap-2" data-testid="details-actions">
      {posts.map((a) => {
        const style = a.style === "primary" ? tone.button : a.style === "danger" ? SEVERITY_TONE.blocking.button : `${SECONDARY}`;
        if (a.id === "revise") {
          return (
            <button key={a.id} type="button" data-action="details-revise" onClick={() => setAsking(true)} className={`${BUTTON} ${SECONDARY}`}>
              {text.action(a.label)}
            </button>
          );
        }
        if (entry.reversible === true || a.id === "reject") {
          return <OneTapButton key={a.id} entry={{ ...entry, actions: [a] }} action={a} className={`${BUTTON} ${style}`} onActed={onActed} />;
        }
        return (
          <ConfirmButton
            key={a.id}
            action={a}
            question={a.id === "send" && sendQuestion ? sendQuestion : t("detailsView.confirmAct", { action: text.action(a.label) })}
            note={a.id === "send" ? t("detailsView.cantUnsend") : undefined}
            yes={a.id === "send" ? t("detailsView.yesSend") : t("detailsView.yes")}
            tone={style}
            onDone={() => onActed(entry)}
          />
        );
      })}
      {links.map((a) => (
        <Link key={a.id} href={a.href!} className={`${BUTTON} ${posts.length ? SECONDARY : tone.button}`}>
          {text.action(a.label)}
        </Link>
      ))}
    </div>
  );
}

function SuggestedBody({ task }: { task: SuggestedTask }) {
  const { t } = useNeedsYouText();
  const detail = useJson<TodoDetail>(`/api/todos/${encodeURIComponent(task.todo.id)}`);
  const description = task.todo.description?.trim();
  return (
    <>
      {description ? (
        <p className="whitespace-pre-wrap text-[13px] leading-[18px] [overflow-wrap:anywhere]" data-testid="details-description">
          {description}
        </p>
      ) : null}
      <SourceSection source={task.source} inboxId={task.todo.source_ref ?? detail?.source?.id ?? null} />
      <WhySection why={t("detailsView.why.suggested")} detail={detail ?? null} />
      <DoesSection ids={["work", "snooze", "dismiss"]} labelOf={(id) => ({ work: "Work on this", snooze: "Snooze", dismiss: "Dismiss" })[id] ?? id} />
      <LinkedSection todo={{ id: task.todo.id, ref: task.todo.ref }} />
    </>
  );
}

function SuggestedActions({
  task,
  canStart,
  onRemoved,
}: {
  task: SuggestedTask;
  canStart: boolean;
  onRemoved: (id: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open: snoozeOpen, setOpen: setSnoozeOpen, ref: snoozeRef } = usePopover<HTMLDivElement>();
  const { run, pending } = useAction(async (verb: "snooze" | "dismiss", option?: SnoozeOption) => {
    const id = encodeURIComponent(task.todo.id);
    const problem =
      verb === "snooze"
        ? await post(`/api/suggested-tasks/${id}/snooze`, { until: snoozeUntil(option?.ms ?? 0).toISOString() })
        : await post(`/api/suggested-tasks/${id}/dismiss`);
    if (problem) return setError(problem);
    announceSuggestedTasksChanged();
    onRemoved(task.todo.id);
  });
  return (
    <div className="flex w-full flex-wrap gap-2" data-testid="details-actions">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {canStart ? (
        <button type="button" data-action="details-work" data-appmcp-hint={SUGGESTED_HINTS.work} onClick={() => setStarting(true)} className={`${BUTTON} ${SEVERITY_TONE.approval.button}`}>
          Work on this
        </button>
      ) : null}
      <div ref={snoozeRef} className="relative">
        <button
          type="button"
          data-action="suggested-snooze"
          data-appmcp-hint={SUGGESTED_HINTS.snooze}
          aria-haspopup="menu"
          aria-expanded={snoozeOpen}
          disabled={pending}
          onClick={() => setSnoozeOpen((v) => !v)}
          className={`${BUTTON} ${SECONDARY}`}
        >
          Snooze
        </button>
        {snoozeOpen ? (
          <div
            role="menu"
            aria-label="Snooze for"
            className="absolute bottom-full left-0 z-[65] mb-1 w-28 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-1 shadow-xl"
          >
            {SNOOZE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                data-snooze={option.id}
                data-appmcp-hint={SUGGESTED_HINTS.snoozeFor(option)}
                disabled={pending}
                onClick={() => {
                  setSnoozeOpen(false);
                  void run("snooze", option);
                }}
                className="block w-full rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)] disabled:opacity-50"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        data-appmcp-hint={SUGGESTED_HINTS.dismiss}
        disabled={pending}
        onClick={() => run("dismiss")}
        className={`${BUTTON} ${SECONDARY}`}
      >
        Dismiss
      </button>
      {starting ? <StartTaskSheet task={task} onClose={() => setStarting(false)} /> : null}
    </div>
  );
}

function NavButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * Details for one Needs-you item: a centred pop-up on desktop, full screen
 * on a phone, with prev / next through the panel's items. A reply to send is
 * sent only after a confirm step, rejected, or sent back with a note that the
 * agent rewrites the draft from (the to-do revision path).
 */
export function NeedsYouDetails({
  item,
  index,
  total,
  onStep,
  onClose,
  now,
  canStart,
  revision,
  onActed,
  onRevise,
  onSuggestedRemoved,
}: {
  item: NeedsYouDetailItem;
  /** Position in the panel's list, or -1 once the item has left it. */
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
  now: number;
  canStart: boolean;
  revision: DraftRevision | null;
  onActed: (entry: NeedsYouEntry) => void;
  onRevise: (entry: NeedsYouEntry, note: string) => void;
  onSuggestedRemoved: (id: string) => void;
}) {
  const text = useNeedsYouText();
  const { t } = text;
  const entry = item.kind === "entry" ? item.entry : null;
  const title = entry ? text.title(entry) : item.kind === "suggested" ? item.task.todo.title : "";
  const tone = entry ? SEVERITY_TONE[entry.severity] ?? SEVERITY_TONE.fyi : null;
  const rewriting = !!revision && revision.answeredKey === item.key;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "ArrowLeft") onStep(-1);
      if (e.key === "ArrowRight") onStep(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onStep]);

  return (
    <Sheet
      title={title}
      onClose={onClose}
      wide
      mobileFull
      component="NeedsYouDetails"
      actions={
        <div className="flex shrink-0 items-center gap-1" data-testid="details-nav">
          <span className="px-1 text-[12px] text-[var(--color-muted)]">
            {index >= 0 ? t("detailsView.of", { i: index + 1, n: total }) : null}
          </span>
          <NavButton label={t("detailsView.prev")} disabled={total < 2 && index >= 0} onClick={() => onStep(-1)}>
            <span aria-hidden>‹</span>
          </NavButton>
          <NavButton label={t("detailsView.next")} disabled={total < 2 && index >= 0} onClick={() => onStep(1)}>
            <span aria-hidden>›</span>
          </NavButton>
        </div>
      }
      footer={
        item.kind === "entry" ? (
          <EntryActions
            key={item.key}
            item={item}
            rewriting={rewriting}
            onActed={onActed}
            onRevise={(note) => onRevise(item.entry, note)}
          />
        ) : (
          <SuggestedActions key={item.key} task={item.task} canStart={canStart} onRemoved={onSuggestedRemoved} />
        )
      }
    >
      <div className="flex flex-col gap-3" data-testid="details-body" data-item={item.key}>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {item.kind === "suggested" ? (
            <>
              <SuggestedTag />
              <ChannelTag channel={item.task.channel} />
              <RefBadge value={item.task.todo.ref} />
            </>
          ) : entry && tone ? (
            <>
              <span className={`font-semibold ${tone.label}`}>{text.severity(entry.severity)}</span>
              <span className="text-[var(--color-muted)]">· {text.age(entry.created_at, now)}</span>
            </>
          ) : null}
        </div>
        <h3 className="text-[15px] font-semibold leading-5 [overflow-wrap:anywhere]" data-testid="details-title">
          {title}
        </h3>
        {item.kind === "entry" ? (
          <EntryBody key={item.key} item={item} revision={revision} />
        ) : (
          <SuggestedBody key={item.key} task={item.task} />
        )}
      </div>
    </Sheet>
  );
}
