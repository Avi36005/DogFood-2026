import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { LinkButton, Panel, PanelHeader, SectionLabel, Status, Tag, When } from "@/components/app/ui";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as teams from "@/lib/domain/teams.ts";
import { get } from "@/lib/db/client.ts";
import { visibleEventName } from "@/lib/page-title.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: (await visibleEventName((await params).slug)) ?? "Event" };
}

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();

  const actor = await currentActor();
  const cap = capabilityFor(actor, event.id);
  if (event.status === "draft" && !cap.isOrganizer) notFound();

  const tracks = events.tracks(event.id);
  const prizes = events.prizes(event.id);
  const myTeam = actor ? teams.teamForUser(event.id, actor.id) : undefined;
  const submitted = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'submitted'`, event.id)?.n ?? 0;

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Status value={event.status} />
            <h1 className="mt-3 text-[36px]">{event.name}</h1>
            {event.tagline ? <p className="mt-2 max-w-2xl text-[16px] text-muted-foreground">{event.tagline}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/events/${slug}/gallery`} tone="secondary">Gallery ({submitted})</LinkButton>
            {event.status === "results_published" ? <LinkButton href={`/events/${slug}/results`}>Results</LinkButton> : null}
            {event.voting_enabled ? <LinkButton href={`/events/${slug}/vote`} tone="secondary">Community vote</LinkButton> : null}
            {event.voting_enabled && event.voting_results_public ? <LinkButton href={`/events/${slug}/community`} tone="secondary">Community results</LinkButton> : null}
          </div>
        </div>

        {/* Role-specific entry points. Only what this actor can actually use. */}
        {(cap.isOrganizer || cap.isJudge || myTeam || (actor && event.status === "open")) ? (
          <div className="mt-8 flex flex-wrap gap-2">
            {cap.isOrganizer ? <LinkButton href={`/events/${slug}/organize`}>Organizer console <ArrowRight size={15} /></LinkButton> : null}
            {cap.isJudge ? <LinkButton href={`/events/${slug}/judge`} tone={cap.isOrganizer ? "secondary" : "primary"}>My review queue <ArrowRight size={15} /></LinkButton> : null}
            {myTeam ? <LinkButton href={`/events/${slug}/team`} tone="secondary">My team &amp; submission</LinkButton> : null}
            {!myTeam && actor && event.status === "open" ? <LinkButton href={`/events/${slug}/team`} tone="secondary">Form a team</LinkButton> : null}
          </div>
        ) : null}

        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            {event.description ? (
              <Panel className="p-6">
                <SectionLabel>// ABOUT</SectionLabel>
                {event.description.split("\n\n").map((p, i) => (
                  <p key={i} className="mt-3 text-[14px] leading-relaxed text-muted-foreground first:mt-0">{p}</p>
                ))}
              </Panel>
            ) : null}

            {tracks.length ? (
              <Panel>
                <PanelHeader title="Tracks" sub={`${tracks.length} in this event`} />
                <ul className="divide-y divide-border/60">
                  {tracks.map((t) => (
                    <li key={t.id} className="px-5 py-4">
                      <h3 className="text-[14px] font-medium text-foreground">{t.name}</h3>
                      {t.description ? <p className="mt-1 text-[13px] text-muted-foreground">{t.description}</p> : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>

          <aside className="space-y-6">
            <Panel>
              <PanelHeader title="Schedule" sub={`Times shown in UTC · event timezone ${event.timezone}`} />
              <ul className="divide-y divide-border/60 text-[13px]">
                {([
                  ["Submissions open", event.submissions_open_at],
                  ["Submissions close", event.submissions_close_at],
                  ["Judging opens", event.judging_open_at],
                  ["Judging closes", event.judging_close_at],
                  ["Results published", event.results_published_at],
                ] as const).map(([label, iso]) => (
                  <li key={label} className="flex items-baseline justify-between gap-3 px-5 py-3">
                    <span className="text-muted-foreground">{label}</span>
                    <When iso={iso} />
                  </li>
                ))}
              </ul>
            </Panel>

            {prizes.length ? (
              <Panel>
                <PanelHeader title="Prizes" />
                <ul className="divide-y divide-border/60">
                  {prizes.map((p) => (
                    <li key={p.id} className="px-5 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[14px] text-foreground">{p.name}</span>
                        {p.amount_text ? <span className="font-mono tabular-nums text-[13px] text-primary">{p.amount_text}</span> : null}
                      </div>
                      {p.description ? <p className="mt-1 text-[12px] text-muted-foreground">{p.description}</p> : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            <Panel className="p-5">
              <h3 className="text-[13px] font-medium text-foreground">Team size</h3>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Up to <span className="font-mono tabular-nums text-foreground">{event.max_team_size}</span> people per team ·{" "}
                <span className="font-mono tabular-nums text-foreground">{event.reviews_per_project}</span> reviews per project.
              </p>
            </Panel>
          </aside>
        </div>
      </main>
    </>
  );
}
