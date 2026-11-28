"use client";

import type { ReactNode } from "react";

import { CreatureIcon } from "@/components/aquarium/CreatureIcon";
import {
  STATUS_LABEL,
  profileCreature,
  type ProfileStatus,
} from "@/components/profiles/profile-cards";
import { InfoTip } from "@/components/ui/InfoTip";
import { Pill, type Tone } from "@/components/ui/Pill";
import { bone, skeletonPulse } from "@/components/ui/Skeleton";
import type { ProfileInfo } from "@/types";

export const STATUS_TONE: Record<ProfileStatus, Tone> = {
  working: "accent",
  ready: "success",
  off: "muted",
  setup: "warning",
};

export const STATUS_DOT: Record<ProfileStatus, string> = {
  working: "bg-[var(--color-accent-fg)]",
  ready: "bg-[var(--color-success)]",
  off: "bg-[var(--color-muted)]",
  setup: "bg-[var(--color-warn)]",
};

export function Skel({ className = "" }: { className?: string }) {
  return (
    <span
      data-skeleton
      aria-hidden
      className={`inline-block align-middle ${bone} ${skeletonPulse} ${className}`}
    />
  );
}

export function StatusPill({
  status,
  needs,
}: {
  status: ProfileStatus;
  needs?: number;
}) {
  if (needs) {
    return (
      <Pill tone="warning">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT.setup}`} />
        {needs} need you
      </Pill>
    );
  }
  return (
    <Pill tone={STATUS_TONE[status]}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {STATUS_LABEL[status]}
    </Pill>
  );
}

export function Avatar({ profile, size }: { profile: ProfileInfo; size: number }) {
  const id = profileCreature(profile);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[28%] border border-[var(--color-border)] bg-[var(--color-surface-2)]"
      style={{ width: size, height: size }}
    >
      <CreatureIcon id={id} size={Math.round(size * 0.8)} />
    </span>
  );
}

export function Metric({
  icon,
  label,
  tip,
  value,
  sub,
  extra,
}: {
  icon: ReactNode;
  label: string;
  tip: string;
  value: ReactNode;
  sub: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div
      data-component="ProfileMetric"
      className="relative min-w-0 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-2.5"
    >
      <div className="flex items-center gap-1 pr-4 text-[10px] font-semibold uppercase text-[var(--color-muted)]">
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="absolute right-1 top-1 z-10 normal-case">
          <InfoTip label={`What is ${label}?`} align="end">
            {tip}
          </InfoTip>
        </span>
      </div>
      <div className="mt-0.5 flex items-end gap-1.5">
        <span className="text-[17px] font-semibold leading-tight">{value}</span>
        {extra}
      </div>
      <div className="truncate text-[11px] text-[var(--color-muted)]">
        {sub}
      </div>
    </div>
  );
}

export function Spark({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <span
      aria-hidden
      data-component="TokenSpark"
      className="mb-1 flex h-4 items-end gap-0.5"
    >
      {values.map((v, i) => (
        <span
          key={i}
          className={`w-1 rounded-sm bg-[var(--color-accent)] ${v ? "opacity-75" : "opacity-25"}`}
          style={{ height: `${Math.max(12, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </span>
  );
}
