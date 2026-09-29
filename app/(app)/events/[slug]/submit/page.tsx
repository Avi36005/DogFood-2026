import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Field, Input, Notice, Panel, PanelHeader, Select, Status, Textarea, When } from "@/components/app/ui";
import { SubmissionForm } from "@/components/app/submission-form";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as teams from "@/lib/domain/teams.ts";
import * as projects from "@/lib/domain/projects.ts";
import * as media from "@/lib/domain/media.ts";
import { MediaPanel } from "@/components/app/media-panel";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Submit project");

export const dynamic = "force-dynamic";

export default async function SubmitPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/submit`);

  const cap = capabilityFor(actor, event.id);
  const team = teams.teamForUser(event.id, actor.id);
  if (!team) redirect(`/events/${slug}/team`);

  const project = projects.ensureDraft(cap, actor, team.id);
  const tracks = events.tracks(event.id);
  const questions = events.questions(event.id);
  const answers = projects.answersFor(project.id);
  const tags = projects.tagsFor(project.id);
  const open = events.submissionsOpen(event);
  const problems = projects.validateForSubmit(project.id, event.id);
  const history = projects.revisions(project.id);
  const thumb = project.thumbnail_asset_id ? media.byId(project.thumbnail_asset_id) ?? null : null;
  const galleryAssets = media.galleryFor(project.id);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 max-w-3xl py-12">
        <Link href={`/events/${slug}/team`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {team.name}</Link>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[32px]">Submission</h1>
          <Status value={project.status} />
        </div>

        {!open ? (
          <div className="mt-6">
            <Notice tone="warn">
              The submission window is closed
              {event.submissions_close_at ? <> (it closed <When iso={event.submissions_close_at} />)</> : null}.
              This form is read-only now. The deadline is enforced on the server, so a saved draft cannot become
              a submission after the fact.
            </Notice>
          </div>
        ) : project.status === "submitted" ? (
          <div className="mt-6">
            <Notice tone="success">
              Submitted <When iso={project.submitted_at} />. You can keep editing until the deadline;
              changes are recorded as new revisions.
            </Notice>
          </div>
        ) : problems.length ? (
          <div className="mt-6">
            <Notice tone="info">
              Still needed before you can submit: {problems.map((p) => p.message).join(" ")}
            </Notice>
          </div>
        ) : null}

        <div className="mt-8">
          <MediaPanel
            slug={slug}
            projectId={project.id}
            thumbnail={thumb ? { id: thumb.id, filename: thumb.filename, bytes: thumb.bytes, mime: thumb.mime } : null}
            gallery={galleryAssets.map((a) => ({ id: a.id, filename: a.filename, bytes: a.bytes, mime: a.mime }))}
            readOnly={!open}
          />
        </div>

        <div className="mt-6">
          <SubmissionForm
            slug={slug}
            project={{
              id: project.id, version: project.version, status: project.status,
              name: project.name, tagline: project.tagline, description: project.description,
              track_id: project.track_id, repo_url: project.repo_url,
              live_url: project.live_url, demo_video_url: project.demo_video_url,
            }}
            tracks={tracks.map((t) => ({ id: t.id, name: t.name }))}
            questions={questions.map((q) => ({
              id: q.id, prompt: q.prompt, kind: q.kind, required: !!q.required,
              helpText: q.help_text, isPublic: !!q.is_public, options: events.questionOptions(q),
            }))}
            answers={answers}
            tags={tags}
            readOnly={!open}
            canSubmit={problems.length === 0}
            problems={problems}
            deadline={event.submissions_close_at}
            timezone={event.timezone}
          />
        </div>

        {history.length ? (
          <Panel className="mt-8">
            <PanelHeader title="Revision history" sub="Every submit is recorded, so an organizer can see what was on file at the deadline." />
            <ul className="divide-y divide-border/60">
              {history.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-3 text-[13px]">
                  <span className="font-mono tabular-nums text-muted-foreground">revision {r.revision}</span>
                  <span className="text-muted-foreground">{r.reason}</span>
                  <When iso={r.created_at} />
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </main>
    </>
  );
}
