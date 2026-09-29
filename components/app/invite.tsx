"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { createInviteAction } from "@/lib/actions/participant.ts";
import { acceptJudgeInviteAction } from "@/lib/actions/judging.ts";
import { Button, Notice } from "./ui";
import { useFormAction } from "./form";

/** Shows a freshly minted invite link once, with a copy affordance. */
export function InviteBox({ slug, teamId }: { slug: string; teamId: string }) {
  const [state, action, pending] = useFormAction(createInviteAction);
  const [copied, setCopied] = useState(false);
  const path = state.ok?.startsWith("/invite/") ? state.ok : null;
  const url = path && typeof window !== "undefined" ? `${window.location.origin}${path}` : path;

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="teamId" value={teamId} />
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? "Generating…" : "Generate invite link"}
        </Button>
      </form>

      {state.error ? <div className="mt-3"><Notice tone="danger">{state.error}</Notice></div> : null}

      {url ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            readOnly value={url} aria-label="Invite link"
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-[44px] flex-1 rounded-[10px] border border-control-border bg-background px-3 font-mono text-[12px] text-foreground"
          />
          <Button
            type="button" tone="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch { /* clipboard blocked; the field is selectable instead */ }
            }}
          >
            {copied ? <><Check size={15} />Copied</> : <><Copy size={15} />Copy</>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The accept button on a judge invitation page. */
export function AcceptJudgeInvite({ token, eventName }: { token: string; eventName: string }) {
  const [state, action, pending, keep] = useFormAction(acceptJudgeInviteAction);
  return (
    <form action={action} {...keep}>
      <input type="hidden" name="token" value={token} />
      {state.error ? <div className="mb-3"><Notice tone="danger">{state.error}</Notice></div> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Accepting…" : `Accept and judge ${eventName}`}
      </Button>
    </form>
  );
}
