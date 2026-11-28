"use client";

import Link from "next/link";
import { useState } from "react";

import { Section, ListBox, EmptyNote } from "@/components/profiles/page/Section";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { useAction } from "@/lib/use-action";
import { sendJson } from "@/components/profiles/api";
import type { McpServer, Source } from "@/types";

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

/**
 * "Ways to reach it" — the inboxes, numbers and bots routed to this agent
 * (each owner's own sources; a toggle per agent), the MCP tool servers it
 * can call, and whether its gateway is live.
 */
export function Connectors({
  profile,
  sources,
  mcpServers,
  gatewayRunning,
}: {
  profile: string;
  sources: Source[];
  mcpServers: McpServer[];
  gatewayRunning: boolean;
}) {
  // Routes belonging to this profile, per source — owned sources only (the
  // list the server sent back is already scoped to the caller's own).
  const routed = sources
    .map((s) => ({
      source: s,
      route: s.routes.find((r) => r.profile === profile) ?? null,
    }))
    .filter(({ source, route }) => route !== null || source.enabled);

  const [routeState, setRouteState] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const { run: toggle, pending } = useAction(async (sourceId: string, enabled: boolean) => {
    setError(null);
    setRouteState((m) => ({ ...m, [sourceId]: enabled }));
    try {
      await sendJson(
        `/api/sources/${encodeURIComponent(sourceId)}/routes/${encodeURIComponent(profile)}`,
        "PUT",
        { enabled },
      );
    } catch (err) {
      setRouteState((m) => ({ ...m, [sourceId]: !enabled }));
      setError(err instanceof Error ? err.message : "Couldn't change the route.");
    }
  });

  const routeOn = (sourceId: string, routeEnabled: boolean) =>
    routeState[sourceId] ?? routeEnabled;

  return (
    <Section
      title="Ways to reach it"
      hint="Your inboxes, numbers and bots — switched per agent. New sources are set up under Sources."
    >
      {error ? <InlineAlert tone="danger" className="mb-2">{error}</InlineAlert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1.5 flex items-baseline justify-between text-xs font-semibold">
            Your sources
            <Link href="/sources" className="text-[11px] font-normal text-[var(--color-accent)] hover:underline">
              Manage sources
            </Link>
          </h3>
          {routed.length ? (
            <ListBox>
              {routed.map(({ source, route }) => {
                const on = route ? routeOn(source.source_id, route.enabled) : false;
                return (
                  <li key={source.source_id} className="flex items-center gap-2 px-3 py-2">
                    <Pill tone="muted">{CHANNEL_LABEL[source.channel] ?? source.channel}</Pill>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {source.display || source.address}
                    </span>
                    {!source.enabled ? <Pill tone="warning">source off</Pill> : null}
                    <RouteSwitch
                      on={on}
                      busy={pending}
                      label={`${source.display || source.address} → ${profile}`}
                      onToggle={() => void toggle(source.source_id, !on)}
                    />
                  </li>
                );
              })}
            </ListBox>
          ) : (
            <EmptyNote>
              None of your sources route to {profile} yet — flip one on under{" "}
              <Link href="/sources" data-appmcp-hint="Opens the Sources page" className="text-[var(--color-accent)] hover:underline">
                Sources
              </Link>
              .
            </EmptyNote>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <h3 className="mb-1.5 text-xs font-semibold">Tool servers (MCP)</h3>
            {mcpServers.length ? (
              <ListBox>
                {mcpServers.map((s) => (
                  <li key={s.name} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                    <Pill tone="muted">{s.transport}</Pill>
                    <Pill tone={s.enabled ? "success" : "muted"}>{s.enabled ? "on" : "off"}</Pill>
                  </li>
                ))}
              </ListBox>
            ) : (
              <EmptyNote>No tool servers configured for this agent.</EmptyNote>
            )}
            <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">
              Manage under{" "}
              <Link href="/settings" className="text-[var(--color-accent)] hover:underline">
                Settings → Tools
              </Link>
              .
            </p>
          </div>

          <div>
            <h3 className="mb-1.5 text-xs font-semibold">Gateway & triage</h3>
            <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5">
              <Pill tone={gatewayRunning ? "success" : "muted"}>
                {gatewayRunning ? "running" : "stopped"}
              </Pill>
              <span className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
                {gatewayRunning
                  ? "Messages it gets are sorted by its triage rules."
                  : "Start the gateway for it to answer messages."}
              </span>
              <Link
                href={`/profiles/${encodeURIComponent(profile)}/triage`}
                className="text-[11px] text-[var(--color-accent)] hover:underline"
              >
                Triage rules
              </Link>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function RouteSwitch({
  on,
  busy,
  label,
  onToggle,
}: {
  on: boolean;
  busy: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-appmcp-hint={`Turns this source ${on ? "off" : "on"} for the agent`}
      disabled={busy}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"
      }`}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: on ? "1.125rem" : "0.125rem" }}
      />
    </button>
  );
}
