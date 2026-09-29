import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import { Empty, Notice, Panel, PanelHeader, Tag } from "@/components/app/ui";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as judging from "@/lib/domain/judging.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const dynamic = "force-dynamic";
export const generateMetadata = eventPageTitle("Review queue");

export default async function JudgeQueue({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/judge`);

  const cap = capabilityFor(actor, event.id);
  if (!cap.isJudge) notFound();   // not "403": a non-judge has no reason to learn this exists

  const queue = judging.queueFor(cap, actor);
  const done = queue.filter((q) => q.review_status === "submitted").length;
  const open = events.judgingOpen(event);
  const rubric = judging.publishedRubric(event.id);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 max-w-4xl py-12">
        <Link href={`/events/${slug}`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {event.name}</Link>
        <h1 className="mt-3 text-[32px]">Your review queue</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          <span className="font-mono tabular-nums text-foreground">{done}</span> of <span className="font-mono tabular-nums text-foreground">{queue.length}</span> complete.
          {cap.judgeTrackIds ? " You are assigned to a single track." : ""}
        </p>

        {!open ? (
          <div className="mt-6"><Notice tone="warn">The judging window is closed. You can read your queue but not submit new scores.</Notice></div>
        ) : null}
        {!rubric ? (
          <div className="mt-6"><Notice tone="warn">The organizer has not published a rubric yet, so scoring is not available.</Notice></div>
        ) : null}

        <Panel className="mt-8">
          <PanelHeader title="Assigned to you" sub="No other judge's scores are visible here, and yours are not visible to them." />
          {queue.length === 0 ? (
            <Empty title="Nothing assigned yet" body="The organizer has not sent you a batch. This page will fill in when they do." />
          ) : (
            <ul className="divide-y divide-border/60">
              {queue.map((q) => {
                const state = q.review_status === "submitted" ? "done" : q.review_status === "draft" ? "draft" : "new";
                const Icon = state === "done" ? CheckCircle2 : state === "draft" ? CircleDot : Circle;
                return (
                  <li key={q.assignment_id}>
                    <Link href={`/events/${slug}/judge/${q.assignment_id}`} className="flex items-start gap-4 px-5 py-4 hover:bg-secondary">
                      <Icon size={18} className={state === "done" ? "mt-0.5 text-success" : state === "draft" ? "mt-0.5 text-warning" : "mt-0.5 text-muted-soft"} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[15px] font-medium text-foreground">{q.project_name}</span>
                          {q.track_name ? <Tag>{q.track_name}</Tag> : null}
                        </div>
                        <p className="mt-1 text-[13px] text-muted-foreground">{q.tagline}</p>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-soft">
                        {state === "done" ? "scored" : state === "draft" ? "in progress" : "not started"}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </main>
    </>
  );
}
