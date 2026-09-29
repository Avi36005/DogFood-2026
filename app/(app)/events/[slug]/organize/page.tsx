import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Cell, Panel, PanelHeader, Row, Table, When } from "@/components/app/ui";
import { StatusControl } from "@/components/app/organizer";
import { SetupChecklist } from "@/components/app/setup";
import { LiveProgress } from "@/components/app/live";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as judging from "@/lib/domain/judging.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Organizer overview");

export const dynamic = "force-dynamic";

export default async function Overview({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const progress = judging.judgeProgress(cap);
  const counts = judging.progressCounts(cap);
  const short = judging.coverageGaps(cap).filter((g) => g.short > 0);
  const notStarted = progress.filter((p) => p.assigned > 0 && p.submitted === 0).length;

  return (
    <div className="space-y-6">
      <LiveProgress slug={slug} initial={counts} />

      <p className="text-[13px] text-muted-foreground">
        {counts.reviews} of {counts.assigned} assigned reviews submitted
        {counts.judges > 0 ? `, across ${counts.judges} judge${counts.judges === 1 ? "" : "s"}` : ""}
        {notStarted > 0 ? ` · ${notStarted} judge${notStarted === 1 ? " has" : "s have"} not started` : ""}.
      </p>

      <SetupChecklist items={events.setupChecklist(cap, slug)} />

      <StatusControl slug={slug} current={event.status} />

      {short.length ? (
        <Panel>
          <PanelHeader
            title={<span className="flex items-center gap-2"><AlertTriangle size={15} className="text-warning" />Coverage gaps</span>}
            sub={`${short.length} project(s) have fewer than ${event.reviews_per_project} submitted reviews.`}
          />
          <Table head={["Project", "Assigned", "Submitted", "Short by"]} caption="Projects with fewer submitted reviews than the target">
            {short.slice(0, 15).map((g) => (
              <Row key={g.id}>
                <Cell>{g.name}</Cell>
                <Cell className="font-mono tabular-nums text-muted-foreground">{g.assigned}</Cell>
                <Cell className="font-mono tabular-nums text-muted-foreground">{g.submitted}</Cell>
                <Cell className="font-mono tabular-nums text-warning">{g.short}</Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader title="Judge progress" sub="Who has not started. Individual scores are not shown here." />
        <Table
          head={["Judge", "Assigned", "Submitted", "In draft", "Last activity"]}
          caption="Each judge's assigned, submitted and draft review counts"
        >
          {progress.map((p) => (
            <Row key={p.user_id}>
              <Cell>
                <div className="text-foreground">{p.display_name}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{p.email}</div>
              </Cell>
              <Cell className="font-mono tabular-nums text-muted-foreground">{p.assigned}</Cell>
              <Cell className={`font-mono tabular-nums ${p.submitted === 0 && p.assigned > 0 ? "text-warning" : "text-foreground"}`}>{p.submitted}</Cell>
              <Cell className="font-mono tabular-nums text-muted-foreground">{p.drafts ?? 0}</Cell>
              <Cell><When iso={p.last_activity} tz={event.timezone} /></Cell>
            </Row>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
