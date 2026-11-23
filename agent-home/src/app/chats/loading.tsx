import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** Route-level loading UI for **All chats** (a `force-dynamic` page). */
export default function Loading() {
  return (
    <MobileShell title="All chats">
      <PageSkeleton rows={3} />
    </MobileShell>
  );
}
