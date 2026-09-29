import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Countdown, Notice, Panel, PanelHeader, Tag, When } from "@/components/app/ui";
import { ReviewForm } from "@/components/app/review-form";
import { JudgeRail } from "@/components/app/judge-rail";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor, AccessDenied } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as judging from "@/lib/domain/judging.ts";
import * as projects from "@/lib/domain/projects.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const dynamic = "force-dynamic";
export const generateMetadata = eventPageTitle("Review");

export default async function ReviewPage({ params }: { params: Promise<{ slug: string; assignmentId: string }> }) {
  const { slug, assignmentId } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/judge/${assignmentId}`);
  const cap = capabilityFor(actor, event.id);

  // openReview re-checks ownership, track grant and conflict of interest, and
  // records the refusal. A judge poking at another judge's id lands here.
  let view: Awaited<ReturnType<typeof judging.openReview>>;
  try {
    view = judging.openReview(cap, actor, assignmentId);
  } catch (err) {
    if (err instanceof AccessDenied) notFound();
    throw err;
  }

  const tags = projects.tagsFor(view.project.id);
  const answers = projects.answersFor(view.project.id);
  const questions = events.questions(event.id).filter((q) => answers[q.id]?.trim());
  const open = events.judgingOpen(event);
  const locked = view.review?.status === "submitted";

  // The queue is the judge's own, resolved on the server from their assignments.
  const queue = judging.queueFor(cap, actor).map((q) => ({
    assignmentId: q.assignment_id,
    projectName: q.project_name,
    tagline: q.tagline,
    trackName: q.track_name,
    state: (q.review_status === "submitted" ? "done" : q.review_status === "draft" ? "draft" : "new") as "done" | "draft" | "new",
  }));
  const here = queue.findIndex((q) => q.assignmentId === assignmentId);
  const previous = here > 0 ? queue[here - 1] : null;
  const next = here >= 0 && here < queue.length - 1 ? queue[here + 1] : null;
  const nextUnfinished = queue.find((q) => q.assignmentId !== assignmentId && q.state !== "done") ?? null;
  const done = queue.filter((q) => q.state === "done").length;
  const trackLabel = cap.judgeTrackIds === null
    ? "all tracks"
    : events.tracks(event.id).filter((t) => cap.judgeTrackIds!.includes(t.id)).map((t) => t.name).join(", ") || "one track";

  const links = [
    { href: view.project.repo_url, label: "Repository" },
    { href: view.project.live_url, label: "Live" },
    { href: view.project.demo_video_url, label: "Demo video" },
  ].filter((l) => l.href);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <Link href={`/events/${slug}/judge`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; Review queue</Link>

        {/* Who you are here, what you may judge, and how far through you are. */}
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-border pb-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[15px] font-semibold text-foreground">{event.name}</span>
            <span className="text-[13px] text-muted-foreground">Judge · {trackLabel}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground">{done}/{queue.length}</span>
            <span>reviews submitted</span>
            {/* The window can close before its date (publishing results ends judging),
                so a countdown is shown only while submissions are actually accepted. */}
            {!open ? (
              <span className="text-foreground">Judging closed</span>
            ) : event.judging_close_at ? (
              <span>
                Judging <When iso={event.judging_close_at} tz={event.timezone} /> · <Countdown iso={event.judging_close_at} />
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[230px_1fr] lg:items-start xl:grid-cols-[230px_1fr_380px]">
          <div className="order-2 lg:order-1">
            <JudgeRail slug={slug} items={queue} currentId={assignmentId} />
          </div>

          {/* The work under review */}
          <div className="order-1 space-y-6 lg:order-2">
            <div>
              <h1 className="text-[30px]">{view.project.name}</h1>
              <p className="mt-2 text-[15px] text-muted-foreground">{view.project.tagline}</p>
              <div className="mt-3 flex flex-wrap gap-2">{tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>
            </div>

            {links.length ? (
              <div className="flex flex-wrap gap-2">
                {links.map((l) => (
                  <a
                    key={l.label} href={l.href} target="_blank" rel="noopener noreferrer nofollow"
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-control-border px-3 text-[13px] text-foreground hover:bg-secondary"
                  >
                    {l.label}<ExternalLink size={13} aria-hidden />
                  </a>
                ))}
              </div>
            ) : null}

            <Panel className="p-6">
              {view.project.description.split("\n\n").map((p, i) => (
                <p key={i} className="mt-4 text-[14px] leading-relaxed text-muted-foreground first:mt-0">{p}</p>
              ))}
            </Panel>

            {questions.length ? (
              <Panel>
                <PanelHeader title="Organizer questions" />
                <dl className="divide-y divide-border/60">
                  {questions.map((q) => (
                    <div key={q.id} className="px-5 py-4">
                      <dt className="text-[13px] font-medium text-foreground">{q.prompt}</dt>
                      <dd className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{answers[q.id]}</dd>
                    </div>
                  ))}
                </dl>
              </Panel>
            ) : null}
          </div>

          {/* The ballot. Sticky so scoring does not require scrolling back. */}
          <div className="order-3 xl:sticky xl:top-24">
            {locked ? (
              <div className="mb-4"><Notice tone="success">You submitted this review. It is now read-only.</Notice></div>
            ) : !open ? (
              <div className="mb-4"><Notice tone="warn">The judging window is closed, so this cannot be submitted.</Notice></div>
            ) : null}

            <ReviewForm
              slug={slug}
              assignmentId={assignmentId}
              rubricName={view.rubric.name}
              criteria={view.criteria.map((c) => ({
                id: c.id, name: c.name, description: c.description,
                weight: c.weight, min: c.scale_min, max: c.scale_max,
              }))}
              scores={view.scores}
              overall={view.review?.overall_comment ?? ""}
              readOnly={locked || !open}
              nextAssignmentId={nextUnfinished?.assignmentId ?? null}
              nextProjectName={nextUnfinished?.projectName ?? null}
            />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px]">
              {previous ? (
                <Link href={`/events/${slug}/judge/${previous.assignmentId}`} className="text-muted-foreground hover:text-foreground">
                  &larr; {previous.projectName}
                </Link>
              ) : <span />}
              {next ? (
                <Link href={`/events/${slug}/judge/${next.assignmentId}`} className="text-muted-foreground hover:text-foreground">
                  {next.projectName} &rarr;
                </Link>
              ) : <span />}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
