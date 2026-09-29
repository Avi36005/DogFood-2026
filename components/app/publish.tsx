"use client";

import { useState } from "react";
import { publishResultsAction } from "@/lib/actions/judging.ts";
import { Button, Notice } from "./ui";
import { useFormAction } from "./form";

/**
 * Publishing makes standings world-readable, so it asks once before doing it.
 */
export function PublishResults({ slug, snapshotId, published }: { slug: string; snapshotId: string; published: boolean }) {
  const [state, action, pending] = useFormAction(publishResultsAction);
  const [confirming, setConfirming] = useState(false);

  if (published) {
    return <span className="text-[13px] text-success">These results are published.</span>;
  }

  return (
    <div>
      {state.error ? <div className="mb-3"><Notice tone="danger">{state.error}</Notice></div> : null}
      {!confirming ? (
        <Button type="button" onClick={() => setConfirming(true)}>Publish results…</Button>
      ) : (
        <form action={action} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="snapshotId" value={snapshotId} />
          <span className="text-[13px] text-warning">
            This makes the standings public to everyone. Continue?
          </span>
          <Button type="submit" disabled={pending}>{pending ? "Publishing…" : "Yes, publish"}</Button>
          <Button type="button" tone="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}
