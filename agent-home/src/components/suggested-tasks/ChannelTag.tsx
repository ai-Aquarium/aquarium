import { channelLabel } from "@/lib/suggested-tasks/channels";

const CHANNEL_TONE: Record<string, string> = {
  email: "border-sky-500/40 text-sky-400",
  whatsapp: "border-emerald-500/40 text-emerald-400",
  telegram: "border-cyan-500/40 text-cyan-400",
  calendar: "border-amber-500/40 text-amber-400",
};

/** The channel a suggested task came in on: Email, WhatsApp, Telegram, Calendar… */
export function ChannelTag({ channel }: { channel: string }) {
  return (
    <span
      data-component="ChannelTag"
      data-channel={channel}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${
        CHANNEL_TONE[channel] ?? "border-[var(--color-border)] text-[var(--color-muted)]"
      }`}
    >
      {channelLabel(channel)}
    </span>
  );
}

/** The "Suggested task" label every suggestion carries, wherever it shows. */
export function SuggestedTag() {
  return (
    <span
      data-component="SuggestedTag"
      className="inline-flex items-center rounded-full bg-[var(--color-accent)]/15 px-2 py-0.5 text-[11px] font-semibold leading-4 text-[var(--color-accent)]"
    >
      Suggested task
    </span>
  );
}
