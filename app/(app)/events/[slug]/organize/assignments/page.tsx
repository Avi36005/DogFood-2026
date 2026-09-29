import { notFound } from "next/navigation";
import { Cell, Panel, PanelHeader, Row, Status, Table } from "@/components/app/ui";
import { GenerateAssignments } from "@/components/app/organizer";
import { ExportLinks } from "@/components/app/exports";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as judging from "@/lib/domain/judging.ts";
import { all } from "@/lib/db/client.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Assignments");

export const dynamic = "force-dynamic";

export default async function AssignmentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const coverage = judging.coverageGaps(cap);
  const loads = all<{ display_name: string; email: string; assigned: number; submitted: number }>(
    `SELECT u.display_name, u.email,
            COUNT(a.id) AS assigned,
            SUM(CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END) AS submitted
       FROM event_roles er
       JOIN users u ON u.id = er.user_id
       LEFT JOIN assignments a ON a.judge_user_id = u.id AND a.event_id = er.event_id AND a.status != 'revoked'
       LEFT JOIN reviews r ON r.assignment_id = a.id
      WHERE er.event_id = ? AND er.role = 'judge'
      GROUP BY u.id ORDER BY assigned DESC, u.display_name`,
    event.id,
  );

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader title="Generate assignments" sub="Balanced round-robin, deterministic for a given event and target." />
        <GenerateAssignments slug={slug} target={event.reviews_per_project} />
      </Panel>

      <Panel>
        <PanelHeader title="Load per judge" sub="A wide spread here usually means track restrictions are doing the work." />
        <Table head={["Judge", "Assigned", "Submitted"]}>
          {loads.map((l) => (
            <Row key={l.email}>
              <Cell>
                <div className="text-foreground">{l.display_name}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{l.email}</div>
              </Cell>
              <Cell className="font-mono tabular-nums text-muted-foreground">{l.assigned}</Cell>
              <Cell className="font-mono tabular-nums text-foreground">{l.submitted ?? 0}</Cell>
            </Row>
          ))}
        </Table>
      </Panel>

      <Panel>
        <PanelHeader title="Coverage" sub={`Target is ${event.reviews_per_project} submitted reviews per project.`} />
        <Table head={["Project", "Assigned", "Submitted", "Short by"]}>
          {coverage.map((c) => (
            <Row key={c.id}>
              <Cell>{c.name}</Cell>
              <Cell className="font-mono tabular-nums text-muted-foreground">{c.assigned}</Cell>
              <Cell className="font-mono tabular-nums text-muted-foreground">{c.submitted}</Cell>
              <Cell className={`font-mono tabular-nums ${c.short ? "text-warning" : "text-success"}`}>{c.short || "—"}</Cell>
            </Row>
          ))}
        </Table>
      </Panel>

      <ExportLinks slug={slug} only={["assignments"]} />
    </div>
  );
}
