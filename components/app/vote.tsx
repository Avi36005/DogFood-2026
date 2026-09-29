"use client";

import { Check, Heart } from "lucide-react";
import { castVoteAction } from "@/lib/actions/community.ts";
import { Notice } from "./ui";
import { useFormAction } from "./form";

/**
 * Vote control. It is a separate form beside the project link, never wrapped
 * around it, so the card's main target still opens the project.
 */
export function VoteButton({
  slug, projectId, projectName, voted, disabledReason,
}: {
  slug: string; projectId: string; projectName: string;
  voted: boolean; disabledReason: string | null;
}) {
  const [state, action, pending] = useFormAction(castVoteAction);

  if (disabledReason) {
    return <span className="text-[12px] text-muted-soft">{disabledReason}</span>;
  }

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="intent" value={voted ? "retract" : "cast"} />
      <button
        type="submit"
        disabled={pending}
        aria-pressed={voted}
        className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[10px] border px-3 text-[13px] transition-colors disabled:opacity-50 ${
          voted
            ? "border-primary bg-primary/15 text-primary"
            : "border-control-border text-muted-foreground hover:border-primary hover:text-foreground"
        }`}
      >
        {voted ? <Check size={14} aria-hidden /> : <Heart size={14} aria-hidden />}
        {pending ? "Saving…" : voted ? "Voted" : "Vote"}
        <span className="sr-only"> for {projectName}</span>
      </button>
      {state.error ? <span className="text-[12px] text-destructive">{state.error}</span> : null}
      {state.ok ? <span className="text-[12px] text-success">{state.ok}</span> : null}
    </form>
  );
}
