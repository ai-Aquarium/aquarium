import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

export default function Loading() {
  return (
    <MobileShell title="Agent profile" back={{ href: "/profiles", label: "Agent profiles" }} wide>
      <PageSkeleton rows={5} />
    </MobileShell>
  );
}
