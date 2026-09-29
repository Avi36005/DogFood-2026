import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Field, Input, LinkButton, Notice, Panel, PanelHeader, Status } from "@/components/app/ui";
import { ActionForm, Submit } from "@/components/app/form";
import { createTeamAction, createInviteAction, leaveTeamAction } from "@/lib/actions/participant.ts";
import { InviteBox } from "@/components/app/invite";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as teams from "@/lib/domain/teams.ts";
import * as projects from "@/lib/domain/projects.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Your team");

export const dynamic = "force-dynamic";

export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/team`);

  const cap = capabilityFor(actor, event.id);
  const team = teams.teamForUser(event.id, actor.id);
  const roster = team ? teams.members(team.id) : [];
  const project = team ? projects.forTeam(team.id) : undefined;
  const canForm = ["draft", "open"].includes(event.status);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 max-w-3xl py-12">
        <Link href={`/events/${slug}`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {event.name}</Link>
        <h1 className="mt-3 text-[32px]">{team ? team.name : "Form a team"}</h1>

        {!team ? (
          <>
            {!canForm ? (
              <div className="mt-6"><Notice tone="warn">Team formation is closed for this event.</Notice></div>
            ) : (
              <Panel className="mt-8 p-6">
                <p className="mb-5 text-[14px] text-muted-foreground">
                  Create a team, then share the invite link with up to {event.max_team_size - 1} teammates.
                  Solo entries are fine: a team of one works the same way.
                </p>
                <ActionForm action={createTeamAction} submitLabel="Create team">
                  <input type="hidden" name="slug" value={slug} />
                  <Field label="Team name" hint="Must be unique within this event.">
                    <Input name="name" required maxLength={80} autoFocus />
                  </Field>
                </ActionForm>
              </Panel>
            )}
          </>
        ) : (
          <div className="mt-8 space-y-6">
            <Panel>
              <PanelHeader
                title="Members"
                sub={`${roster.length} of ${event.max_team_size} seats used`}
              />
              <ul className="divide-y divide-border/60">
                {roster.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <div>
                      <div className="text-[14px] text-foreground">{m.display_name}</div>
                      <div className="font-mono text-[12px] text-muted-foreground">{m.email}</div>
                    </div>
                    <span className="font-mono text-[11px] uppercase tracking-wide text-muted-soft">{m.role}</span>
                  </li>
                ))}
              </ul>
            </Panel>

            {roster.length < event.max_team_size && canForm ? (
              <Panel className="p-6">
                <h2 className="text-[15px] font-semibold text-foreground">Invite a teammate</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Generates a single link. It expires in 14 days and stops working once the team is full.
                </p>
                <div className="mt-4"><InviteBox slug={slug} teamId={team.id} /></div>
              </Panel>
            ) : null}

            <Panel>
              <PanelHeader
                title="Submission"
                sub={project ? "Your team's entry for this event." : "Nothing started yet."}
                action={project ? <Status value={project.status} /> : null}
              />
              <div className="px-5 py-5">
                <LinkButton href={`/events/${slug}/submit`}>
                  {project && project.status !== "draft" ? "View or edit submission" : "Open the submission form"}
                </LinkButton>
              </div>
            </Panel>

            <form action={async (fd: FormData) => { "use server"; await leaveTeamAction({}, fd); }}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="teamId" value={team.id} />
              <Submit tone="danger">Leave this team</Submit>
            </form>
          </div>
        )}
      </main>
    </>
  );
}
