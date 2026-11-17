"use client";

import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, type ReactNode } from "react";

import { SwitchOnArrival } from "@/components/SwitchOnArrival";

/**
 * Everything a page renders belongs to the session's profile, so:
 *
 * - With `followLink` (the pages Needs you / notifications link to with
 *   `?profile=`, e.g. `/todos?profile=finance`), a link naming another
 *   profile switches the session there first. The switch endpoint re-checks
 *   the enrolment; a refused switch (not enrolled, suspended) says why and
 *   nothing of the named profile is read. Pages that read `?profile=` as
 *   their own selector (Users, Skills, Models) leave it off.
 * - The content is keyed on the profile: a switch remounts it with the new
 *   profile's server data instead of leaving client state (rows, cursors,
 *   errors) from the previous profile on screen.
 */
export function ProfileScope({
  current,
  followLink = false,
  children,
}: {
  current: string;
  followLink?: boolean;
  children: ReactNode;
}) {
  const scoped = <Fragment key={current}>{children}</Fragment>;
  if (!followLink) return scoped;
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
