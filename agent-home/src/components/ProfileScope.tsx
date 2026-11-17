"use client";

import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, type ReactNode } from "react";

import { SwitchOnArrival } from "@/components/SwitchOnArrival";

/**
 * Everything a page renders belongs to the session's profile, so:
 *
 * - A link naming another profile (`/todos?profile=finance`, e.g. Needs you ›
 *   Open on another profile's item) switches the session there first. The
 *   switch endpoint re-checks the enrolment; a refused switch (not enrolled,
 *   suspended) says why and nothing of the named profile is read.
 * - The content is keyed on the profile: a switch remounts it with the new
 *   profile's server data instead of leaving client state (rows, cursors,
 *   errors) from the previous profile on screen.
 */
export function ProfileScope({ current, children }: { current: string; children: ReactNode }) {
  const scoped = <Fragment key={current}>{children}</Fragment>;
  return (
    <Suspense fallback={scoped}>
      <Arrival current={current}>{scoped}</Arrival>
    </Suspense>
  );
}

function Arrival({ current, children }: { current: string; children: ReactNode }) {
  const wanted = (useSearchParams()?.get("profile") ?? "").trim();
  if (wanted && wanted !== current) {
    return <SwitchOnArrival key={wanted} profile={wanted} current={current} />;
  }
  return <>{children}</>;
}
