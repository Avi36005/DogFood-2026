import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Cell, Empty, Panel, PanelHeader, Row, Table, When } from "@/components/app/ui";
import * as events from "@/lib/domain/events.ts";
import * as results from "@/lib/domain/results.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const dynamic = "force-dynamic";

export const generateMetadata = eventPageTitle("Results");

function Delta({ value }: { value: number | null }) {
  if (!value) return <span className="inline-flex items-center gap-1 text-muted-soft"><Minus size={12} />0</span>;
  const up = value > 0;
  return (
    <span className={`inline-flex items-center gap-1 ${up ? "text-success" : "text-warning"}`}>
      {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}{Math.abs(value)}
    </span>
  );
}

export default async function ResultsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();

  const published = results.publicResults(event.id);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <Link href={`/events/${slug}`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {event.name}</Link>
        <h1 className="mt-3 text-[32px]">Results</h1>

        {!published ? (
          <Panel className="mt-8">
            <Empty
              title="Results are not published yet"
              body="Scores stay with the organizer until the event publishes them. Nothing here is visible to anyone else in the meantime."
            />
          </Panel>
        ) : (
          <>
            <p className="mt-2 text-[14px] text-muted-foreground">
              Published <When iso={published.snapshot.published_at} /> · scored with cross-judge normalization.{" "}
              <Link href="/docs#judging" className="text-primary hover:underline">How this is calculated</Link>
            </p>

            <Panel className="mt-8">
              <PanelHeader
                title="Final standings"
                sub="Normalized score is the ranking figure. Raw is the unadjusted mean, shown so the adjustment is visible."
              />
              <Table head={["#", "Project", "Team", "Track", "Normalized", "Raw", "Usable reviews", "Movement"]}>
                {published.rows.map((r) => (
                  <Row key={r.id}>
                    <Cell className="font-mono tabular-nums text-muted-foreground">{r.rank ?? "—"}</Cell>
                    <Cell className="font-medium">{r.project_name}</Cell>
                    <Cell className="text-muted-foreground">{r.team_name}</Cell>
                    <Cell className="text-muted-foreground">{r.track_name ?? "—"}</Cell>
                    <Cell className="font-mono tabular-nums text-primary">
                      {r.sufficient ? r.normalized_mean?.toFixed(2)
                        : <span className="text-muted-foreground">not ranked</span>}
                    </Cell>
                    <Cell className="font-mono tabular-nums text-muted-foreground">{r.raw_mean?.toFixed(2)}</Cell>
                    <Cell className="font-mono tabular-nums text-muted-foreground">{r.usable_reviews}</Cell>
                    <Cell className="font-mono tabular-nums"><Delta value={r.rank_delta} /></Cell>
                  </Row>
                ))}
              </Table>
            </Panel>

            <p className="mt-4 text-[12px] text-muted-soft">
              Movement compares the normalized ranking against the ranking raw averages would have produced.
            </p>
          </>
        )}
      </main>
    </>
  );
}
