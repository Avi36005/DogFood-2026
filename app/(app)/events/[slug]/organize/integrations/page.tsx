import Link from "next/link";
import { notFound } from "next/navigation";
import { Cell, Notice, Panel, PanelHeader, Row, Status, Table, When } from "@/components/app/ui";
import { ApiKeys, Webhooks, BundleTools, IssueRecord } from "@/components/app/integrations";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as webhooksDomain from "@/lib/domain/webhooks.ts";
import * as recordsDomain from "@/lib/domain/records.ts";
import * as judging from "@/lib/domain/judging.ts";
import * as keysApi from "@/lib/api/keys.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Integrations");

export const dynamic = "force-dynamic";

export default async function Integrations({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const keys = keysApi.list(cap);
  const hooks = webhooksDomain.list(cap);
  const deliveries = webhooksDomain.deliveries(cap, 20);
  const issued = recordsDomain.issuedFor(cap);
  const judges = judging.judgeProgress(cap).filter((j) => j.submitted > 0);

  return (
    <div className="space-y-6">
      <Notice tone="info">
        These are T4 stretch features. Coverage is partial and documented in{" "}
        <Link href="/docs#api" className="text-primary hover:underline">the docs</Link> — the API does not yet
        mirror every action the interface can take.
      </Notice>

      <Panel>
        <PanelHeader
          title="API keys"
          sub={<>A key grants exactly what you can do, nothing more. Spec at{" "}
            <Link href="/api/v1/openapi.json" className="text-primary hover:underline">/api/v1/openapi.json</Link>.</>}
        />
        <ApiKeys slug={slug} keys={keys.map((k) => ({ id: k.id, label: k.label, scopes: k.scopes, created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at }))} />
      </Panel>

      <Panel>
        <PanelHeader title="Webhooks" sub="Signed, at-least-once delivery with bounded retries. Private and reserved addresses are refused." />
        <Webhooks
          slug={slug}
          topics={[...webhooksDomain.TOPICS]}
          hooks={hooks.map((h) => ({ id: h.id, url: h.url, topics: h.topics, last_status: h.last_status, failures: h.failures }))}
        />
      </Panel>

      {deliveries.length ? (
        <Panel>
          <PanelHeader title="Recent deliveries" sub="Consumers must deduplicate on the delivery id; retries can repeat." />
          <Table head={["When", "Topic", "Endpoint", "Status", "Attempts", "Last error"]}>
            {deliveries.map((d) => (
              <Row key={d.id}>
                <Cell><When iso={d.created_at} /></Cell>
                <Cell className="font-mono text-[12px]">{d.topic}</Cell>
                <Cell className="max-w-[220px] truncate text-muted-foreground">{d.url}</Cell>
                <Cell className={d.status === "delivered" ? "text-success" : d.status === "pending" ? "text-muted-foreground" : "text-destructive"}>{d.status}</Cell>
                <Cell className="font-mono tabular-nums text-muted-foreground">{d.attempts}</Cell>
                <Cell className="max-w-[200px] truncate text-[12px] text-muted-soft">{d.last_error}</Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader title="Whole-event bundle" sub="Export everything, or import a bundle as a new draft event. Import is all-or-nothing." />
        <BundleTools slug={slug} />
      </Panel>

      <Panel>
        <PanelHeader
          title="Signed participation records"
          sub={<>Ed25519. Anyone can check one at{" "}
            <Link href="/verify" className="text-primary hover:underline">/verify</Link> without an account.</>}
        />
        <IssueRecord slug={slug} judges={judges.map((j) => ({ id: j.user_id, name: j.display_name, submitted: j.submitted }))} />
        {issued.length ? (
          <Table head={["Record", "Recipient", "Key", "Issued"]}>
            {issued.map((r) => (
              <Row key={r.id}>
                <Cell><Link href={`/records/${r.id}`} className="font-mono text-[12px] text-primary hover:underline">{r.id}</Link></Cell>
                <Cell>{r.display_name}</Cell>
                <Cell className="font-mono text-[11px] text-muted-foreground">{r.key_id}</Cell>
                <Cell><When iso={r.created_at} /></Cell>
              </Row>
            ))}
          </Table>
        ) : null}
      </Panel>

      <Panel>
        <PanelHeader title="Embeddable gallery" sub="Read-only, public projects only." />
        <div className="px-5 py-5">
          <pre className="overflow-x-auto rounded-[10px] border border-border bg-background px-4 py-3 font-mono text-[12px] text-muted-foreground">
            <code>{`<iframe
  src="http://localhost:3000/embed/${slug}?limit=12"
  title="Project gallery"
  loading="lazy"
  style="width:100%;height:620px;border:0"
  referrerpolicy="no-referrer"></iframe>`}</code>
          </pre>
          <p className="mt-3 text-[12px] text-muted-foreground">
            A standalone host page for testing this from a different origin is in{" "}
            <code className="font-mono text-primary">examples/embed-host.html</code>.
          </p>
        </div>
      </Panel>
    </div>
  );
}
