import { notFound } from "next/navigation";
import { Cell, Notice, Panel, PanelHeader, Row, Status, Table, When } from "@/components/app/ui";
import { RubricEditor } from "@/components/app/organizer";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as judging from "@/lib/domain/judging.ts";
import { all } from "@/lib/db/client.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Rubric");

export const dynamic = "force-dynamic";

export default async function RubricPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const published = judging.publishedRubric(event.id);
  const criteria = published ? judging.criteria(published.id) : [];
  const total = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  const versions = all<{ id: string; version: number; name: string; status: string; published_at: string | null }>(
    `SELECT id, version, name, status, published_at FROM rubric_versions WHERE event_id = ? ORDER BY version DESC`,
    event.id,
  );

  return (
    <div className="space-y-6">
      {published ? (
        <Panel>
          <PanelHeader
            title={`Published: ${published.name} (v${published.version})`}
            sub="This is what judges score against right now."
          />
          <Table head={["Criterion", "What it measures", "Weight", "Share", "Scale"]}>
            {criteria.map((c) => (
              <Row key={c.id}>
                <Cell className="font-medium">{c.name}</Cell>
                <Cell className="max-w-md text-muted-foreground">{c.description}</Cell>
                <Cell className="font-mono tabular-nums text-muted-foreground">{c.weight}</Cell>
                <Cell className="font-mono tabular-nums text-primary">{Math.round((c.weight / total) * 100)}%</Cell>
                <Cell className="font-mono tabular-nums text-muted-foreground">{c.scale_min}–{c.scale_max}</Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      ) : (
        <Notice tone="warn">
          No rubric is published yet. Judges cannot score until one exists.
        </Notice>
      )}

      <Panel>
        <PanelHeader
          title="Publish a new version"
          sub="Publishing supersedes the current version. Reviews already submitted keep the version they used."
        />
        <RubricEditor
          slug={slug}
          existing={criteria.length ? criteria.map((c) => ({ name: c.name, weight: c.weight, description: c.description })) : null}
        />
      </Panel>

      {versions.length > 1 ? (
        <Panel>
          <PanelHeader title="Version history" />
          <Table head={["Version", "Name", "Status", "Published"]}>
            {versions.map((v) => (
              <Row key={v.id}>
                <Cell className="font-mono tabular-nums">v{v.version}</Cell>
                <Cell>{v.name}</Cell>
                <Cell><Status value={v.status} /></Cell>
                <Cell><When iso={v.published_at} /></Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      ) : null}
    </div>
  );
}
