import { notFound } from "next/navigation";
import { Cell, Panel, PanelHeader, Row, Table } from "@/components/app/ui";
import { InviteJudge, Invitations, RemoveJudge } from "@/components/app/organizer";
import { ExportLinks } from "@/components/app/exports";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as invitations from "@/lib/domain/invitations.ts";
import * as judging from "@/lib/domain/judging.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Judging panel");

export const dynamic = "force-dynamic";

export default async function PanelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const members = events.panel(cap);
  const tracks = events.tracks(event.id);
  const judges = members.filter((m) => m.role === "judge");
  const organizers = members.filter((m) => m.role === "organizer");
  const progress = new Map(judging.judgeProgress(cap).map((p) => [p.user_id, p]));
  const invites = invitations.listForEvent(cap);

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title="Invite a judge"
          sub="A scoped, one-use link. Forgeboard sends no email, so you pass it on yourself."
        />
        <InviteJudge slug={slug} tracks={tracks.map((t) => ({ id: t.id, name: t.name }))} />
      </Panel>

      <Panel>
        <PanelHeader title="Invitations" sub={`${invites.filter((i) => invitations.invitationState(i) === "pending").length} still open`} />
        <Invitations
          slug={slug}
          invitations={invites.map((i) => ({
            id: i.id,
            state: invitations.invitationState(i),
            trackName: i.track_name ?? null,
            addressedTo: i.email_ci ? i.email_ci.replace(/^(.).*(@.*)$/, "$1…$2") : "",
            createdAt: i.created_at,
            expiresAt: i.expires_at,
            acceptedName: i.accepted_name ?? null,
          }))}
        />
      </Panel>

      <Panel>
        <PanelHeader title="Judges" sub={`${judges.length} on the panel`} />
        <Table head={["Name", "Email", "Scope", "Reviews", ""]} caption="Judges on this event's panel">
          {judges.map((m) => {
            const p = progress.get(m.user_id);
            return (
              <Row key={`${m.user_id}-${m.track_id ?? "all"}`}>
                <Cell className="font-medium">{m.display_name}</Cell>
                <Cell className="font-mono text-[12px] text-muted-foreground">{m.email}</Cell>
                <Cell className={m.track_name ? "text-warning" : "text-muted-foreground"}>
                  {m.track_name ? `${m.track_name} only` : "All tracks"}
                </Cell>
                <Cell className="font-mono tabular-nums text-muted-foreground">
                  {p ? `${p.submitted}/${p.assigned}` : "0/0"}
                </Cell>
                <Cell>
                  <RemoveJudge slug={slug} userId={m.user_id} name={m.display_name} submitted={p?.submitted ?? 0} />
                </Cell>
              </Row>
            );
          })}
        </Table>
        {judges.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted-soft">
            Nobody has accepted an invitation yet.
          </p>
        ) : null}
      </Panel>

      <Panel>
        <PanelHeader title="Organizers" sub={`${organizers.length} with full access to this event`} />
        <Table head={["Name", "Email"]} caption="Organizers of this event">
          {organizers.map((m) => (
            <Row key={m.user_id}>
              <Cell className="font-medium">{m.display_name}</Cell>
              <Cell className="font-mono text-[12px] text-muted-foreground">{m.email}</Cell>
            </Row>
          ))}
        </Table>
      </Panel>

      <ExportLinks slug={slug} only={["judges"]} />
    </div>
  );
}
