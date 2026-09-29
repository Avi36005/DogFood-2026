import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Cell, Notice, Panel, PanelHeader, Row, Status, Table, When } from "@/components/app/ui";
import { VotingSettings, InvalidateVoter, ModerateComment } from "@/components/app/community-admin";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as voting from "@/lib/domain/voting.ts";
import * as comments from "@/lib/domain/comments.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Community settings");

export const dynamic = "force-dynamic";

export default async function CommunityAdmin({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const state = voting.votingState(event);
  const tally = event.voting_enabled ? voting.tally(cap) : [];
  const signals = event.voting_enabled ? voting.abuseSignals(cap) : [];
  const thread = event.comments_enabled ? comments.forEvent(cap, 100) : [];
  const totalVotes = tally.reduce((a, t) => a + t.votes, 0);

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title="Community settings"
          sub="Voting and comments are off by default. Nothing here affects judge scores."
        />
        <VotingSettings
          slug={slug}
          event={{
            voting_enabled: !!event.voting_enabled,
            voting_mode: event.voting_mode,
            votes_per_voter: event.votes_per_voter,
            voting_results_public: !!event.voting_results_public,
            comments_enabled: !!event.comments_enabled,
            voting_open_at: event.voting_open_at,
            voting_close_at: event.voting_close_at,
          }}
        />
      </Panel>

      {event.voting_enabled ? (
        <>
          <Panel>
            <PanelHeader
              title="Interim totals"
              sub={`${totalVotes} live vote(s) · window is ${state} · visible to organizers only until you publish.`}
            />
            {state !== "closed" && !event.voting_results_public ? (
              <div className="px-5 pt-4">
                <Notice tone="info">
                  These numbers are not reachable by anyone else, through any page, export or API route.
                </Notice>
              </div>
            ) : null}
            <Table head={["Project", "Votes"]}>
              {tally.slice(0, 25).map((t) => (
                <Row key={t.project_id}>
                  <Cell>{t.project_name}</Cell>
                  <Cell className="font-mono tabular-nums text-primary">{t.votes}</Cell>
                </Row>
              ))}
            </Table>
          </Panel>

          <Panel>
            <PanelHeader
              title={<span className="flex items-center gap-2"><AlertTriangle size={15} className="text-warning" />Review signals</span>}
              sub="Things worth a look. None of these assert fraud on their own."
            />
            {signals.length === 0 ? (
              <p className="px-5 py-5 text-[13px] text-muted-soft">Nothing flagged.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {signals.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11px] uppercase tracking-wide text-warning">{s.kind}</div>
                      <p className="mt-1 text-[13px] text-muted-foreground">{s.detail}</p>
                    </div>
                    {s.voter_id ? <InvalidateVoter slug={slug} voterId={s.voter_id} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}

      {event.comments_enabled ? (
        <Panel>
          <PanelHeader title="Comment moderation" sub="Removing a comment hides it; the author's text is retained in the record." />
          {thread.length === 0 ? (
            <p className="px-5 py-5 text-[13px] text-muted-soft">No comments yet.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {thread.map((c) => (
                <li key={c.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13px] font-medium text-foreground">{c.author_name}</span>
                      <When iso={c.created_at} />
                    </div>
                    <Status value={c.status === "removed" ? "withdrawn" : "submitted"} />
                  </div>
                  <p className="mt-1.5 whitespace-pre-line text-[13px] text-muted-foreground">{c.body}</p>
                  {c.moderation_reason ? (
                    <p className="mt-1 text-[12px] text-warning">Reason: {c.moderation_reason}</p>
                  ) : null}
                  <div className="mt-2">
                    <ModerateComment slug={slug} commentId={c.id} removed={c.status === "removed"} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
