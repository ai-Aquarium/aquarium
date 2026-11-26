import type { ProjectRun, ProjectRunBrief } from "@/types";

function runPath(slug: string, runNo: number): string {
  return `/api/projects/${encodeURIComponent(slug)}/runs/${runNo}`;
}

export function runScorePath(slug: string, runNo: number): string {
  return `${runPath(slug, runNo)}/score`;
}

export function runActionPath(slug: string, runNo: number, action: string): string {
  return `${runPath(slug, runNo)}/${action}`;
}

export async function readRun(slug: string, runNo: number): Promise<ProjectRun> {
  const res = await fetch(runPath(slug, runNo), { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as ProjectRun;
}

/** The run record (newest 50); the project read carries only the last few. */
export async function readRunHistory(slug: string): Promise<ProjectRunBrief[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/runs`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(String(res.status));
  const body = (await res.json()) as { runs?: ProjectRunBrief[] };
  return Array.isArray(body.runs) ? body.runs : [];
}
