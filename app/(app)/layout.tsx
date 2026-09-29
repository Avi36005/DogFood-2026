import type { ReactNode } from "react";
import { Sidebar, PublicBar, type NavGroup } from "@/components/app/sidebar";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as teams from "@/lib/domain/teams.ts";
import { mayCreateEvent } from "@/lib/domain/instance.ts";
import { get } from "@/lib/db/client.ts";

// Built per request: the sidebar reflects this actor's real roles.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await currentActor();

  // Visitors get a light top bar, not a sidebar full of things they cannot open.
  if (!actor) {
    return (
      <div className="app-light min-h-screen">
        <PublicBar />
        {children}
      </div>
    );
  }

  const groups: NavGroup[] = [{
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
      { href: "/events", label: "Events", icon: "events" },
      ...(mayCreateEvent(actor).allowed ? [{ href: "/events/new", label: "Create event", icon: "create" as const }] : []),
    ],
  }];

  // One group per event this person has a role in, showing only what they can open.
  for (const e of events.listForActor(actor).slice(0, 4)) {
    const cap = capabilityFor(actor, e.id);
    const team = teams.teamForUser(e.id, actor.id);
    if (!cap.isOrganizer && !cap.isJudge && !cap.isParticipant && !team) continue;
    const base = `/events/${e.slug}`;
    const items: NavGroup["items"] = [];
    if (cap.isOrganizer) items.push({ href: `${base}/organize`, label: "Organizer console", icon: "organize" });
    if (cap.isJudge) {
      const left = get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM assignments a LEFT JOIN reviews r ON r.assignment_id = a.id
          WHERE a.event_id = ? AND a.judge_user_id = ? AND a.status != 'revoked'
            AND (r.status IS NULL OR r.status != 'submitted')`, e.id, actor.id)?.n ?? 0;
      items.push({ href: `${base}/judge`, label: "Review queue", icon: "judge", badge: left || undefined });
    }
    if (team || cap.isParticipant) items.push({ href: `${base}/team`, label: "My team", icon: "team" });
    if (team) items.push({ href: `${base}/submit`, label: "Submission", icon: "submit" });
    items.push({ href: `${base}/gallery`, label: "Gallery", icon: "gallery" });
    if (e.voting_enabled) items.push({ href: `${base}/vote`, label: "Community vote", icon: "vote" });
    groups.push({ label: e.name, items });
  }

  groups.push({
    label: "More",
    items: [
      ...(actor.globalRole === "admin" ? [{ href: "/admin", label: "Administration", icon: "admin" as const }] : []),
      { href: "/docs", label: "Documentation", icon: "docs" },
      { href: "/verify", label: "Verify a record", icon: "verify" },
    ],
  });

  return (
    <div className="app-light min-h-screen">
      <Sidebar
        groups={groups}
        user={{ name: actor.displayName, detail: actor.globalRole === "admin" ? "Instance admin" : actor.email }}
      />
      <div className="lg:pl-[17.5rem]">{children}</div>
    </div>
  );
}
