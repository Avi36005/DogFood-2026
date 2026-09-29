import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Empty, Notice, Panel, PanelHeader, Tag, When } from "@/components/app/ui";
import { VoteButton } from "@/components/app/vote";
import { EmailGate } from "@/components/app/email-gate";
import { currentActor } from "@/lib/auth/session.ts";
import * as events from "@/lib/domain/events.ts";
import * as voting from "@/lib/domain/voting.ts";
import { VOTER_COOKIE } from "@/lib/voter-cookie.ts";
import { get } from "@/lib/db/client.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const dynamic = "force-dynamic";
export const generateMetadata = eventPageTitle("Community vote");

export default async function VotePage({
  params, searchParams,
}: { params: Promise<{ slug: string }>; searchParams: Promise<{ token?: string }> }) {
  const { slug } = await params;
  const { token } = await searchParams;
  const event = events.bySlug(slug);
  if (!event) notFound();
  if (!event.voting_enabled) notFound();

  const actor = await currentActor();
  const jar = await cookies();
  const cookie = jar.get(VOTER_COOKIE)?.value ?? null;
  const state = voting.votingState(event);

  // Resolving does not create a voter for modes that require proof first.
  const { voter, needs } = voting.resolveVoter(event, { actor, voterCookie: cookie, ip: null });

  const voted = voter ? new Set(voting.liveVotesFor(voter.id)) : new Set<string>();
  const remaining = voter ? voting.remainingBudget(event, voter.id) : event.votes_per_voter;
  const order = voter ? voting.ballotOrder(event.id, voter.id) : [];
  const projects = order.map((id) =>
    get<{ id: string; name: string; tagline: string; track_name: string | null }>(
      `SELECT p.id, p.name, p.tagline, t.name AS track_name
         FROM projects p LEFT JOIN tracks t ON t.id = p.track_id WHERE p.id = ?`, id)!,
  );

  const closedReason =
    state === "not_started" ? `Voting opens ${event.voting_open_at?.slice(0, 16).replace("T", " ")} UTC.`
    : state === "closed" ? "Voting has closed for this event."
    : null;

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 max-w-3xl py-12">
        <Link href={`/events/${slug}`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {event.name}</Link>
        <h1 className="mt-3 text-[32px]">Community vote</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          {event.votes_per_voter} vote{event.votes_per_voter === 1 ? "" : "s"} per person.
          Projects are shown in a different order for every voter, so position does not decide anything.
        </p>

        <div className="mt-5 space-y-3">
          {closedReason ? <Notice tone="warn">{closedReason}</Notice> : null}
          {event.voting_close_at && state === "open" ? (
            <p className="text-[13px] text-muted-foreground">Closes <When iso={event.voting_close_at} tz={event.timezone} /></p>
          ) : null}
        </div>

        {needs === "sign_in" ? (
          <div className="mt-8">
            <Notice tone="info">
              This event uses authenticated voting.{" "}
              <Link href={`/signin?next=/events/${slug}/vote`} className="text-primary hover:underline">Sign in</Link> to vote.
            </Notice>
          </div>
        ) : needs === "email_verification" ? (
          <div className="mt-8"><EmailGate slug={slug} presetToken={token ?? null} /></div>
        ) : (
          <>
            <Panel className="mt-8">
              <PanelHeader
                title="Your ballot"
                sub={state === "open"
                  ? `${remaining} of ${event.votes_per_voter} vote(s) remaining. Withdraw one to move it elsewhere.`
                  : "Read-only."}
              />
              {projects.length === 0 ? (
                <Empty title="No eligible projects yet" body="Projects appear here once they are submitted." />
              ) : (
                <ul className="divide-y divide-border/60">
                  {projects.map((p) => {
                    const has = voted.has(p.id);
                    const disabled =
                      state !== "open" ? "voting closed"
                      : !has && remaining === 0 ? "no votes left"
                      : null;
                    return (
                      <li key={p.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                        <div className="min-w-0 flex-1">
                          <Link href={`/events/${slug}/projects/${p.id}`} className="text-[15px] font-medium text-foreground hover:text-primary">
                            {p.name}
                          </Link>
                          <p className="mt-1 text-[13px] text-muted-foreground">{p.tagline}</p>
                          {p.track_name ? <div className="mt-2"><Tag>{p.track_name}</Tag></div> : null}
                        </div>
                        <VoteButton
                          slug={slug} projectId={p.id} projectName={p.name}
                          voted={has} disabledReason={disabled}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <p className="mt-4 text-[12px] text-muted-soft">
              Vote counts are hidden from everyone but the organizer until voting closes and they choose to
              publish them.
            </p>
          </>
        )}
      </main>
    </>
  );
}
