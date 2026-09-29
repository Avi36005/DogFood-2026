import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Status } from "@/components/app/ui";
import { PillTabs } from "@/components/app/pill-tabs";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as audit from "@/lib/domain/audit.ts";

export const dynamic = "force-dynamic";

const TABS = [
  ["", "Overview"],
  ["/setup", "Setup"],
  ["/projects", "Projects"],
  ["/panel", "Panel"],
  ["/rubric", "Rubric"],
  ["/assignments", "Assignments"],
  ["/results", "Results"],
  ["/community", "Community"],
  ["/integrations", "Integrations"],
  ["/audit", "Audit"],
] as const;

export default async function OrganizeLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/organize`);
  const cap = capabilityFor(actor, event.id);
  // Organizer-only, decided on the server before any child renders.
  if (!cap.isOrganizer) notFound();
  // An instance admin who does not organize this event is allowed in, and the
  // event's own audit trail says so.
  audit.adminAccess(cap, "organizer console");

  return (
    <div className="mx-auto max-w-7xl px-6 pb-12 pt-8 lg:px-8">
      <Link href={`/events/${slug}`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {event.name}</Link>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[30px] tracking-tight">Organizer console</h1>
        <Status value={event.status} />
      </div>
      <div className="mt-6">
        <PillTabs tabs={TABS.map(([path, label]) => ({ href: `/events/${slug}/organize${path}`, label }))} />
      </div>
      <main className="pt-8">{children}</main>
    </div>
  );
}
