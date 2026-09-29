"use client";

import { useEffect, useState } from "react";
import { addCommentAction } from "@/lib/actions/community.ts";
import { Button, Notice, Panel, PanelHeader, Textarea } from "./ui";
import { useFormAction } from "./form";

export type PublicComment = {
  id: string; body: string; status: string; created_at: string; author_name?: string;
};

export function CommentThread({
  slug, projectId, comments, canPost, signedIn,
}: {
  slug: string; projectId: string; comments: PublicComment[];
  canPost: boolean; signedIn: boolean;
}) {
  const [state, action, pending, keep] = useFormAction(addCommentAction);
  // Keep the typed text if the post is rejected; clear it once it is posted.
  const [draft, setDraft] = useState("");
  useEffect(() => { if (state.ok) setDraft(""); }, [state]);

  return (
    <Panel>
      <PanelHeader title="Comments" sub={`${comments.filter((c) => c.status === "visible").length} visible`} />

      {comments.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-muted-soft">No comments yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {comments.map((c) => (
            <li key={c.id} className="px-5 py-4">
              {c.status === "removed" ? (
                <p className="text-[13px] italic text-muted-soft">This comment was removed by a moderator.</p>
              ) : (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-foreground">{c.author_name}</span>
                    <time dateTime={c.created_at} className="font-mono tabular-nums text-[11px] text-muted-soft">
                      {c.created_at.slice(0, 16).replace("T", " ")} UTC
                    </time>
                  </div>
                  {/* Rendered as text: React escapes it, so stored markup is inert. */}
                  <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{c.body}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canPost ? (
        <form action={action} {...keep} className="border-t border-border px-5 py-4">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="projectId" value={projectId} />
          {state.error ? <div className="mb-3"><Notice tone="danger">{state.error}</Notice></div> : null}
          {state.ok ? <div className="mb-3"><Notice tone="success">{state.ok}</Notice></div> : null}
          {!signedIn ? (
            <p className="text-[13px] text-muted-foreground">Sign in to leave a comment.</p>
          ) : (
            <>
              <label htmlFor="comment-body" className="mb-1.5 block text-[13px] font-medium text-foreground">
                Add a comment
              </label>
              <Textarea
                id="comment-body" name="body" rows={3} maxLength={2000}
                value={draft} onChange={(e) => setDraft(e.currentTarget.value)}
                placeholder="Say something useful about this project."
              />
              <div className="mt-3 flex items-center gap-3">
                <Button type="submit" disabled={pending || !draft.trim()}>
                  {pending ? "Posting…" : "Post comment"}
                </Button>
                <span className="text-[12px] text-muted-soft">{draft.length}/2000</span>
              </div>
            </>
          )}
        </form>
      ) : null}
    </Panel>
  );
}
