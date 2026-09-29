import { notFound } from "next/navigation";
import { Cell, Panel, PanelHeader, Row, Table, When } from "@/components/app/ui";
import { ExportLinks } from "@/components/app/exports";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as audit from "@/lib/domain/audit.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Audit trail");

export const dynamic = "force-dynamic";

export default async function AuditPage({
  params, searchParams,
}: { params: Promise<{ slug: string }>; searchParams: Promise<{ page?: string }> }) {
  const { slug } = await params;
  const { page } = await searchParams;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const per = 100;
  const current = Math.max(1, Number(page) || 1);
  const rows = audit.listForEvent(event.id, per, (current - 1) * per);
  const total = audit.countForEvent(event.id);
  const pages = Math.max(1, Math.ceil(total / per));

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title="Audit trail"
          sub={`${total} entries. Every state change and every refused access attempt, append-only.`}
        />
        <Table head={["When", "Actor", "Action", "Subject", "Outcome", "Detail"]}>
          {rows.map((r) => (
            <Row key={r.id}>
              <Cell><When iso={r.created_at} /></Cell>
              <Cell className="text-muted-foreground">{r.actor_label}</Cell>
              <Cell className="font-mono text-[12px] text-foreground">{r.action}</Cell>
              <Cell className="font-mono text-[11px] text-muted-foreground">
                {r.subject_type}{r.subject_id ? ` ${r.subject_id.slice(0, 12)}…` : ""}
              </Cell>
              <Cell className={r.outcome === "denied" ? "text-destructive" : "text-muted-foreground"}>{r.outcome}</Cell>
              <Cell className="max-w-xs truncate font-mono text-[11px] text-muted-soft">
                {r.detail_json === "{}" ? "" : r.detail_json}
              </Cell>
            </Row>
          ))}
        </Table>
        {pages > 1 ? (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-[13px]">
            <span className="text-muted-foreground">Page {current} of {pages}</span>
            <div className="flex gap-3">
              {current > 1 ? <a href={`?page=${current - 1}`} className="text-primary hover:underline">Previous</a> : null}
              {current < pages ? <a href={`?page=${current + 1}`} className="text-primary hover:underline">Next</a> : null}
            </div>
          </div>
        ) : null}
      </Panel>
      <ExportLinks slug={slug} only={["audit"]} />
    </div>
  );
}
