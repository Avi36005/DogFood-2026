import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Github, PlayCircle } from "lucide-react";
import { Panel, PanelHeader, Status, Tag, When } from "@/components/app/ui";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor, isProjectOwner } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as projects from "@/lib/domain/projects.ts";
import * as judging from "@/lib/domain/judging.ts";
import * as media from "@/lib/domain/media.ts";
import * as commentsDomain from "@/lib/domain/comments.ts";
import { CommentThread } from "@/components/app/comments";
import { get } from "@/lib/db/client.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Project");

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ slug: string; projectId: string }> }) {
  const { slug, projectId } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const project = projects.byId(projectId);
  if (!project || project.event_id !== event.id) notFound();

  const actor = await currentActor();
  const cap = capabilityFor(actor, event.id);
  const owner = isProjectOwner(actor, projectId);

  // A draft, withdrawn or disqualified project is visible only to its team and
  // to organizers: it is out of the gallery, so it is out of the direct link too.
  if (project.status !== "submitted" && !owner && !cap.isOrganizer) notFound();
  if (project.disqualified_at && !owner && !cap.isOrganizer) notFound();

  const team = get<{ name: string }>(`SELECT name FROM teams WHERE id = ?`, project.team_id)!;
  const track = project.track_id ? get<{ name: string }>(`SELECT name FROM tracks WHERE id = ?`, project.track_id) : null;
  const tags = projects.tagsFor(projectId);
  const shots = media.galleryFor(projectId);
  const thread = event.comments_enabled && project.status === "submitted"
    ? commentsDomain.forProject(projectId) : [];
  // Private answers stay private: the team, the organizers and the assigned
  // judges see everything, a visitor sees only what the organizer marked public.
  const assignedJudge = !!actor && cap.isJudge && get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assignments a
      WHERE a.project_id = ? AND a.judge_user_id = ? AND a.status != 'revoked'`,
    projectId, actor.id)!.n > 0;
  const seesPrivate = owner || cap.isOrganizer || assignedJudge;
  const questions = events.questions(event.id).filter((q) => seesPrivate || q.is_public === 1);
  const answers = projects.answersFor(projectId);
  // Written feedback is released only once results are out, and never attributed.
  const feedback = event.status === "results_published" && (owner || cap.isOrganizer)
    ? judging.feedbackForProject(projectId) : [];

  const links = [
    { href: project.repo_url, label: "Repository", Icon: Github },
    { href: project.live_url, label: "Live", Icon: ExternalLink },
    { href: project.demo_video_url, label: "Demo video", Icon: PlayCircle },
  ].filter((l) => l.href);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <Link href={`/events/${slug}/gallery`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; Gallery</Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[34px]">{project.name || "Untitled project"}</h1>
            <p className="mt-2 max-w-2xl text-[16px] text-muted-foreground">{project.tagline}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {project.status !== "submitted" ? <Status value={project.status} /> : null}
            {project.disqualified_at ? <Status value="disqualified" /> : null}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {track ? <Tag>{track.name}</Tag> : null}
          {tags.map((t) => <Tag key={t}>{t}</Tag>)}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
          <div className="space-y-6">
            <Panel className="p-6">
              {project.description
                ? project.description.split("\n\n").map((p, i) => (
                    <p key={i} className="mt-4 text-[14px] leading-relaxed text-muted-foreground first:mt-0">{p}</p>
                  ))
                : <p className="text-[14px] text-muted-soft">No description was provided.</p>}
            </Panel>

            {shots.length ? (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {shots.map((a) => (
                  <li key={a.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/media/${a.id}`}
                      alt={a.filename}
                      className="w-full rounded-[12px] border border-border object-cover"
                    />
                  </li>
                ))}
              </ul>
            ) : null}

            {questions.filter((q) => answers[q.id]?.trim()).length ? (
              <Panel>
                <PanelHeader title="Organizer questions" />
                <dl className="divide-y divide-border/60">
                  {questions.filter((q) => answers[q.id]?.trim()).map((q) => (
                    <div key={q.id} className="px-5 py-4">
                      <dt className="text-[13px] font-medium text-foreground">
                        {q.prompt}
                        {!q.is_public ? (
                          <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                            not public
                          </span>
                        ) : null}
                      </dt>
                      <dd className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{answers[q.id]}</dd>
                    </div>
                  ))}
                </dl>
              </Panel>
            ) : null}

            {event.comments_enabled && project.status === "submitted" ? (
              <CommentThread
                slug={slug}
                projectId={projectId}
                comments={thread.map((c) => ({
                  id: c.id, body: c.body, status: c.status,
                  created_at: c.created_at, author_name: c.author_name,
                }))}
                canPost
                signedIn={!!actor}
              />
            ) : null}

            {feedback.length ? (
              <Panel>
                <PanelHeader title="Judge feedback" sub="Written comments, shown without judge identity." />
                <ul className="divide-y divide-border/60">
                  {feedback.map((f, i) => (
                    <li key={i} className="px-5 py-4">
                      <p className="text-[13px] leading-relaxed text-muted-foreground">{f.overall_comment}</p>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>

          <aside className="space-y-6">
            <Panel>
              <PanelHeader title="Submission" />
              <dl className="divide-y divide-border/60 text-[13px]">
                <div className="flex justify-between gap-3 px-5 py-3">
                  <dt className="text-muted-foreground">Team</dt><dd className="text-foreground">{team.name}</dd>
                </div>
                <div className="flex justify-between gap-3 px-5 py-3">
                  <dt className="text-muted-foreground">Submitted</dt><dd><When iso={project.submitted_at} /></dd>
                </div>
              </dl>
            </Panel>

            {links.length ? (
              <Panel>
                <PanelHeader title="Links" />
                <ul className="divide-y divide-border/60">
                  {links.map(({ href, label, Icon }) => (
                    <li key={label}>
                      <a
                        href={href} target="_blank" rel="noopener noreferrer nofollow"
                        className="flex items-center gap-2.5 px-5 py-3 text-[13px] text-primary hover:bg-secondary"
                      >
                        <Icon size={15} aria-hidden />{label}
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </aside>
        </div>
      </main>
    </>
  );
}
