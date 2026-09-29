import Link from "next/link";
import { LinkButton, Notice, Panel, PanelHeader } from "@/components/app/ui";
import { AcceptJudgeInvite } from "@/components/app/invite";
import { currentActor } from "@/lib/auth/session.ts";
import * as invitations from "@/lib/domain/invitations.ts";

export const dynamic = "force-dynamic";

/**
 * Accepting a judge invitation. The page shows the event, the role and the
 * track scope and nothing else — no ids, no panel, no submissions — and the
 * grant itself is read from the invitation row on the server.
 */
export default async function JudgeInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preview = invitations.preview(token);
  const actor = await currentActor();

  if (!preview) {
    return (
      <Shell title="This invitation is not valid">
        <Notice tone="danger">
          The link is wrong, or it was never issued by this instance. Ask the organizer for a new one.
        </Notice>
      </Shell>
    );
  }

  if (preview.state !== "pending") {
    const words: Record<string, string> = {
      accepted: "This invitation has already been used.",
      revoked: "The organizer revoked this invitation.",
      expired: "This invitation has expired.",
    };
    return (
      <Shell title={`Judge invitation for ${preview.eventName}`}>
        <Notice tone="warn">{words[preview.state]} Ask the organizer for a new link.</Notice>
        <p className="text-[13px] text-muted-foreground">
          If you have already accepted it, your judging queue is at{" "}
          <Link href={`/events/${preview.eventSlug}/judge`} className="text-primary hover:underline">
            /events/{preview.eventSlug}/judge
          </Link>.
        </p>
      </Shell>
    );
  }

  if (!actor) {
    return (
      <Shell title={`Judge invitation for ${preview.eventName}`}>
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          You have been invited to judge{" "}
          <span className="text-foreground">{preview.eventName}</span>
          {preview.trackName ? <> in the <span className="text-foreground">{preview.trackName}</span> track</> : <> across all tracks</>}.
          {preview.addressedTo ? <> The invitation is addressed to <span className="font-mono text-[13px]">{preview.addressedTo}</span>.</> : null}
        </p>
        <p className="text-[13px] text-muted-foreground">
          Sign in, or create an account on this instance, and this page will let you accept it.
        </p>
        <div className="flex flex-wrap gap-3">
          <LinkButton href={`/signin?next=/invite/judge/${token}`}>Sign in</LinkButton>
          <LinkButton href={`/register?next=/invite/judge/${token}`} tone="secondary">Create an account</LinkButton>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={`Judge invitation for ${preview.eventName}`}>
      <p className="text-[14px] leading-relaxed text-muted-foreground">
        Accepting adds <span className="text-foreground">{actor.displayName}</span> to the judging panel for{" "}
        <span className="text-foreground">{preview.eventName}</span>
        {preview.trackName ? <>, restricted to the <span className="text-foreground">{preview.trackName}</span> track</> : <>, across all tracks</>}.
        {preview.note ? <> The organizer added: “{preview.note}”.</> : null}
      </p>
      <p className="text-[13px] text-muted-soft">
        You will see only the projects assigned to you, and no other judge&rsquo;s scores.
      </p>
      <AcceptJudgeInvite token={token} eventName={preview.eventName} />
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 lg:px-8">
      <Panel>
        <PanelHeader title={title} sub="Judge invitation" />
        <div className="space-y-5 px-6 py-6">{children}</div>
      </Panel>
    </div>
  );
}
