import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

export default function Loading() {
  return (
    <MobileShell title="My triage skills" wide>
      <PageSkeleton rows={4} />
    </MobileShell>
  );
}
