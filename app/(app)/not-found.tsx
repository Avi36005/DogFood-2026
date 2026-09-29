import Link from "next/link";
import { LinkButton, Panel, PanelHeader } from "@/components/app/ui";

/**
 * Also the answer to "does this exist and am I allowed to see it?", which is
 * why it does not say whether the thing exists: an event, project, assignment
 * or console you have no access to looks exactly like one that is not there.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 lg:px-8">
      <Panel>
        <PanelHeader title="Not found" sub="This page does not exist, or it is not yours to open." />
        <div className="space-y-5 px-6 py-6">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            If you followed a link from an organizer, ask them to check that it is the right one and that
            your account has been added to the event. Signing in as a different account can also be the
            answer.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <LinkButton href="/events">Browse events</LinkButton>
            <Link href="/dashboard" className="text-[13px] text-muted-foreground hover:text-foreground">
              Your dashboard
            </Link>
            <Link href="/signin" className="text-[13px] text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
          </div>
        </div>
      </Panel>
    </div>
  );
}
