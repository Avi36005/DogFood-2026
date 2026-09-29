"use client";

import { useState } from "react";
import {
  saveVotingSettingsAction, invalidateVotesAction, moderateCommentAction,
} from "@/lib/actions/community.ts";
import { Button, Field, Input, Notice, Select } from "./ui";
import { useFormAction } from "./form";

const utcLocal = (iso: string | null) => (iso ? iso.slice(0, 16) : "");

export function VotingSettings({ slug, event }: {
  slug: string;
  event: {
    voting_enabled: boolean; voting_mode: string; votes_per_voter: number;
    voting_results_public: boolean; comments_enabled: boolean;
    voting_open_at: string | null; voting_close_at: string | null;
  };
}) {
  const [state, action, pending, keep] = useFormAction(saveVotingSettingsAction);
  return (
    <form action={action} {...keep} className="space-y-5 px-5 py-5">
      <input type="hidden" name="slug" value={slug} />
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}

      <label className="flex items-start gap-3">
        <input type="checkbox" name="voting_enabled" defaultChecked={event.voting_enabled} className="mt-1 h-4 w-4 accent-primary" />
        <span>
          <span className="block text-[14px] text-foreground">Enable community voting</span>
          <span className="block text-[12px] text-muted-foreground">Community votes are reported separately and never mixed into judge scores.</span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Access mode" hint="Each mode's real limitation is documented on the ballot page.">
          <Select name="voting_mode" defaultValue={event.voting_mode}>
            <option value="authenticated">Authenticated — needs an account on this instance</option>
            <option value="email_gated">Email-gated — one-use link, delivered by you</option>
            <option value="open_link">Open link — a server-issued cookie only</option>
          </Select>
        </Field>
        <Field label="Votes per voter">
          <Input type="number" name="votes_per_voter" min={1} max={100} defaultValue={event.votes_per_voter} className="font-mono tabular-nums" />
        </Field>
        <Field label="Voting opens (UTC)">
          <Input type="datetime-local" name="voting_open_at" defaultValue={utcLocal(event.voting_open_at)} />
        </Field>
        <Field label="Voting closes (UTC)">
          <Input type="datetime-local" name="voting_close_at" defaultValue={utcLocal(event.voting_close_at)} />
        </Field>
      </div>

      <label className="flex items-start gap-3">
        <input type="checkbox" name="voting_results_public" defaultChecked={event.voting_results_public} className="mt-1 h-4 w-4 accent-primary" />
        <span>
          <span className="block text-[14px] text-foreground">Publish community results after voting closes</span>
          <span className="block text-[12px] text-muted-foreground">Totals stay private while the window is open, whatever this is set to.</span>
        </span>
      </label>

      <label className="flex items-start gap-3">
        <input type="checkbox" name="comments_enabled" defaultChecked={event.comments_enabled} className="mt-1 h-4 w-4 accent-primary" />
        <span>
          <span className="block text-[14px] text-foreground">Enable comments on submitted projects</span>
          <span className="block text-[12px] text-muted-foreground">Signed-in accounts only, rate limited, with moderation.</span>
        </span>
      </label>

      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save community settings"}</Button>
    </form>
  );
}

export function InvalidateVoter({ slug, voterId }: { slug: string; voterId: string }) {
  const [state, action, pending, keep] = useFormAction(invalidateVotesAction);
  const [open, setOpen] = useState(false);
  if (!open) {
    return <Button type="button" tone="secondary" onClick={() => setOpen(true)}>Review…</Button>;
  }
  return (
    <form action={action} {...keep} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="voterId" value={voterId} />
      <input
        name="reason" required placeholder="Reason (recorded)" aria-label="Reason for invalidating"
        className="min-h-[38px] w-56 rounded-[10px] border border-control-border bg-background px-3 text-[13px] text-foreground"
      />
      <Button type="submit" tone="danger" disabled={pending}>Invalidate votes</Button>
      {state.error ? <span className="text-[12px] text-destructive">{state.error}</span> : null}
    </form>
  );
}

export function ModerateComment({ slug, commentId, removed }: { slug: string; commentId: string; removed: boolean }) {
  const [state, action, pending, keep] = useFormAction(moderateCommentAction);
  return (
    <form action={action} {...keep} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="commentId" value={commentId} />
      <input type="hidden" name="intent" value={removed ? "restore" : "remove"} />
      {!removed ? (
        <input
          name="reason" required placeholder="Reason (recorded)" aria-label="Moderation reason"
          className="min-h-[34px] w-56 rounded-[8px] border border-control-border bg-background px-2 text-[12px] text-foreground"
        />
      ) : null}
      <button
        type="submit" disabled={pending}
        className="rounded-md border border-control-border px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        {removed ? "Restore" : "Remove"}
      </button>
      {state.error ? <span className="text-[12px] text-destructive">{state.error}</span> : null}
    </form>
  );
}
