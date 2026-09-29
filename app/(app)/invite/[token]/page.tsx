import Link from "next/link";
import { redirect } from "next/navigation";
import { Notice, Panel } from "@/components/app/ui";
import { ActionForm } from "@/components/app/form";
import { acceptInviteAction } from "@/lib/actions/participant.ts";
import { currentActor } from "@/lib/auth/session.ts";
import * as teams from "@/lib/domain/teams.ts";

export const metadata = { title: "Team invite" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const actor = await currentActor();
  const preview = teams.previewInvite(token);

  if (actor && !preview) {
    // Signed in but the link is dead: say so rather than bouncing to a login.
  } else if (!actor) {
    redirect(`/signin?next=/invite/${encodeURIComponent(token)}`);
  }

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 flex justify-center py-20">
        <div className="w-full max-w-[460px]">
          <h1 className="text-[30px]">Team invite</h1>

          {!preview ? (
            <div className="mt-6 space-y-4">
              <Notice tone="danger">
                This invite link is not valid. It may have expired, been revoked, or already been used the
                maximum number of times.
              </Notice>
              <Link href="/events" className="inline-block text-[13px] text-primary hover:underline">Browse events instead</Link>
            </div>
          ) : (
            <Panel className="mt-7 p-6">
              <p className="text-[14px] text-muted-foreground">You have been invited to join</p>
              <p className="mt-1 text-[20px] font-semibold text-foreground">{preview.teamName}</p>
              <p className="mt-1 text-[14px] text-muted-foreground">
                for <Link href={`/events/${preview.eventSlug}`} className="text-primary hover:underline">{preview.eventName}</Link>
              </p>
              <p className="font-mono tabular-nums mt-4 text-[13px] text-muted-foreground">
                {preview.memberCount} of {preview.maxTeamSize} seats taken
              </p>
              <div className="mt-6">
                <ActionForm action={acceptInviteAction} submitLabel="Join this team">
                  <input type="hidden" name="token" value={token} />
                </ActionForm>
              </div>
            </Panel>
          )}
        </div>
      </main>
    </>
  );
}
