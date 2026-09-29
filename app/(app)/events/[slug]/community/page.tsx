import Link from "next/link";
import { notFound } from "next/navigation";
import { Empty, Panel, PanelHeader, Cell, Row, Table } from "@/components/app/ui";
import * as events from "@/lib/domain/events.ts";
import * as voting from "@/lib/domain/voting.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const dynamic = "force-dynamic";
export const generateMetadata = eventPageTitle("Community results");

/**
 * Community vote results, published separately from judge results as the T3
 * brief requires. Totals appear only after voting has closed AND the organizer
 * has released them; before that this page shows nothing but the reason.
 */
export default async function CommunityResults({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event || event.status === "draft" || !event.voting_enabled) notFound();

  const tally = voting.publicTally(event);
  const state = voting.votingState(event);
  const total = tally?.reduce((a, t) => a + t.votes, 0) ?? 0;
  const top = tally?.[0]?.votes ?? 0;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 lg:px-8">
      <Link href={`/events/${slug}`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {event.name}</Link>
      <h1 className="mt-2 text-[32px] tracking-tight">Community results</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The public vote, reported on its own. It is never mixed into the judges&rsquo; scores.
      </p>

      {!tally ? (
        <Panel className="mt-8">
          <Empty
            title="Community results are not public yet"
            body={state !== "closed"
              ? "Voting is still open or has not started. Totals stay hidden from everyone but the organizer until it closes."
              : "Voting has closed, but the organizer has not released the totals."}
          />
        </Panel>
      ) : (
        <Panel className="mt-8">
          <PanelHeader title="Final tally" sub={`${total} vote${total === 1 ? "" : "s"} counted after moderation`} />
          <Table head={["#", "Project", "Votes", ""]}>
            {tally.map((t, i) => (
              <Row key={t.project_id}>
                <Cell className="w-10 font-mono tabular-nums text-muted-foreground">{i + 1}</Cell>
                <Cell>
                  <Link href={`/events/${slug}/projects/${t.project_id}`} className="font-medium hover:underline">{t.project_name}</Link>
                </Cell>
                <Cell className="w-16 font-mono tabular-nums">{t.votes}</Cell>
                <Cell className="w-1/3">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
                    <div className="h-full rounded-full bg-brand" style={{ width: top ? `${(100 * t.votes) / top}%` : "0%" }} />
                  </div>
                </Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      )}
    </main>
  );
}
