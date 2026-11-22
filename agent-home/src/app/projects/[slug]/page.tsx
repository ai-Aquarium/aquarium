import { notFound, redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { ProjectsLoadError } from "@/components/projects/ProjectsLoadError";
import { ProjectDetailView, type ProjectChat } from "@/components/projects/ProjectDetailView";
import { withoutViewParam } from "@/components/projects/tabs/sections";
import { RefBadge } from "@/components/refs/RefBadge";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { storageConfigured } from "@/lib/env";
import { activeEnrolments } from "@/lib/api/my-profiles";
import type {
  ProfileSummary,
  ProjectChatTimeline,
  ProjectBoardView,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectDoctorDetail,
  ProjectPlaybookResponse,
} from "@/types";

// Reads the live principal + the project record per request — never at build
// time.
export const dynamic = "force-dynamic";

/**
 * **The one place** (§13): everything a project knows, on one page.
 *
 * The detail read is the only mandatory fetch; the board, playbook and
 * directives are fan-out reads (§16) — each in its own try/catch so a dead
 * profile only blanks its own panel, never the page.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requirePrincipal();
  const { slug } = await params;
  const query = (await searchParams) ?? {};
  // Task mode is gone: an old `?view=task|project` link lands on the one page.
  const unified = withoutViewParam(`/projects/${encodeURIComponent(slug)}`, query);
  if (unified) redirect(unified);
  const rawTab = query?.tab;
  const initialTab = Array.isArray(rawTab) ? rawTab[0] : rawTab;
  const client = await apiClientForRequest();

  // Fetch under the try, render outside it — JSX built inside a try/catch
  // never reaches the catch (the render happens later).
  let project: ProjectDetail | null = null;
  try {
    project = await client.project(slug);
  } catch (err) {
    // A 404 is the API's deliberate answer for a missing *or unreadable*
    // project (§11) — render Next's own not-found, not a load error (F7).
    if (err instanceof HermesApiError && err.status === 404) notFound();
  }

  if (!project) {
    return (
      <MobileShell followProfileLink title="Project">
        <ProjectsLoadError component="ProjectPageError" details={"Couldn't load this project right now."} />
      </MobileShell>
    );
  }

  const [board, playbook, directives, doctor, chat] = await Promise.all([
    client.projectBoard(slug).catch((): ProjectBoardView | null => null),
    client.projectPlaybook(slug).catch(
      (): ProjectPlaybookResponse | null => null,
    ),
    client.projectDirectives(slug).catch(
      (): ProjectDirectivesResponse | null => null,
    ),
    client.projectDoctor(slug).catch((): ProjectDoctorDetail | null => null),
    projectChat(slug, project.profiles.map((p) => p.profile)),
  ]);
  const isInstanceAdmin = principal.role === "owner" || principal.role === "admin";

  return (
    <MobileShell
      followProfileLink
      title={
        project.ref ? (
          <span className="inline-flex min-w-0 items-center gap-2">
            <RefBadge value={project.ref} className="text-[13px]" />
            <span className="min-w-0">{project.name}</span>
          </span>
        ) : (
          project.name
        )
      }
      wide
    >
      <ProjectDetailView
        project={project}
        board={board}
        playbook={playbook}
        directives={directives}
        doctor={doctor}
        callerUserId={principal.user_id}
        isInstanceAdmin={isInstanceAdmin}
        initialTab={initialTab}
        chat={chat}
      />
    </MobileShell>
  );
}

/**
 * The docked project chat (stage 2): the caller's per-profile conversations
 * in this project merged into one timeline, and the profiles they may pick.
 * Best-effort — a failed read leaves the dock saying chat is unavailable.
 */
async function projectChat(slug: string, projectProfiles: string[]): Promise<ProjectChat> {
  const sessionProfile = (await readSession())?.profile ?? "default";
  const client = await apiClientForRequest();
  const [timeline, profiles] = await Promise.all([
    client.projectChatTimeline(slug).catch((): ProjectChatTimeline | null => null),
    client
      .myProfiles()
      .then(activeEnrolments)
      .catch((): ProfileSummary[] => []),
  ]);
  return {
    profile: timeline?.last_profile ?? sessionProfile,
    storageEnabled: storageConfigured(),
    profiles,
    projectProfiles,
    timeline,
  };
}
