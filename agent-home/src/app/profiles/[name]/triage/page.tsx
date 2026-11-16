import { MobileShell } from "@/components/MobileShell";
import { TriageSkillsView } from "@/components/profiles/triage/TriageSkillsView";
import { InfoTip } from "@/components/ui/InfoTip";
import { requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { isTriageTab } from "@/lib/triage/layers";

export const dynamic = "force-dynamic";

/**
 * Profile › My triage skills. Every signed-in person edits only their own
 * layer; Hermes scopes it to the caller and gates template edits itself.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const principal = await requirePrincipal();
  const { name } = await params;
  const { kind } = await searchParams;
  const profile = decodeURIComponent(name);
  const back = canAdminister(principal)
    ? { href: `/profiles?open=${encodeURIComponent(profile)}`, label: profile }
    : { href: "/", label: "Home" };

  return (
    <MobileShell
      title="My triage skills"
      subtitle={`How ${profile} sorts the messages it gets from your sources. Your version sits on top of the ${profile} template.`}
      info={
        <InfoTip label="About triage skills">
          Each triage file has up to three layers: Aquarium&apos;s built-in text, the {profile} template, and your own
          version. The highest one wins. Your version and your on/off switches only change triage for you.
        </InfoTip>
      }
      back={back}
      wide
    >
      <TriageSkillsView key={profile} profile={profile} initialKind={isTriageTab(kind) ? kind : "email"} />
    </MobileShell>
  );
}
