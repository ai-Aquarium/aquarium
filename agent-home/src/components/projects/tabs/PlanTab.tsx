"use client";

import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

export function PlanTab({ project, playbook, canLead, callerUserId, onDiscussInChat }: ProjectTabProps) {
  const role = project.members.find((m) => m.user_id === callerUserId)?.role ?? null;
  return (
    <div data-component="PlanTab">
      <PlanPanel
        slug={project.slug}
        playbook={playbook}
        profiles={project.profiles.map((row) => row.profile)}
        hostProfile={project.host_profile}
        canActivate={canLead}
        canPropose={canLead || role === "member"}
        callerUserId={callerUserId}
        onAsk={onDiscussInChat}
        archived={project.archived}
        latestRunNo={
          project.runs.length > 0 ? Math.max(...project.runs.map((r) => r.run_no)) : null
        }
      />
    </div>
  );
}
