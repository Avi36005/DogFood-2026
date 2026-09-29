"use client";

import { useState } from "react";
import { requestVoteTokenAction, redeemVoteTokenAction } from "@/lib/actions/community.ts";
import { Button, Notice, Panel, PanelHeader } from "./ui";
import { useFormAction } from "./form";

/**
 * Email-gated voting. Forgeboard has no mail server, so the one-use link is
 * produced here and the operator distributes it through their own channel.
 * The token itself is a real expiring, single-use possession proof; the
 * delivery channel is the part we do not provide, and we say so.
 */
export function EmailGate({ slug, presetToken }: { slug: string; presetToken: string | null }) {
  const [req, request, requesting, keepRequest] = useFormAction(requestVoteTokenAction);
  const [red, redeem, redeeming] = useFormAction(redeemVoteTokenAction);
  const [email, setEmail] = useState("");
  const link = req.ok?.startsWith("/events/") ? req.ok : null;

  return (
    <Panel>
      <PanelHeader title="Verify your email to vote" sub="One-use link, valid for 30 minutes." />
      <div className="space-y-6 px-5 py-5">
        {presetToken ? (
          <form action={redeem}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="token" value={presetToken} />
            {red.error ? <div className="mb-3"><Notice tone="danger">{red.error}</Notice></div> : null}
            <p className="mb-3 text-[13px] text-muted-foreground">You opened a verification link. Confirm to start voting.</p>
            <Button type="submit" disabled={redeeming}>{redeeming ? "Verifying…" : "Verify and continue"}</Button>
          </form>
        ) : (
          <form action={request} {...keepRequest}>
            <input type="hidden" name="slug" value={slug} />
            {req.error ? <div className="mb-3"><Notice tone="danger">{req.error}</Notice></div> : null}
            <label htmlFor="voter-email" className="mb-1.5 block text-[13px] font-medium text-foreground">
              Email address
            </label>
            <input
              id="voter-email" name="email" type="email" required
              value={email} onChange={(e) => setEmail(e.currentTarget.value)}
              className="min-h-[44px] w-full max-w-sm rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground focus:border-primary focus:outline-none"
            />
            <div className="mt-3">
              <Button type="submit" disabled={requesting || !email.trim()}>
                {requesting ? "Working…" : "Get a verification link"}
              </Button>
            </div>
          </form>
        )}

        {link ? (
          <Notice tone="info">
            <p className="mb-2">
              This instance sends no email. Copy the link below and deliver it through your own channel,
              or open it now to verify this browser.
            </p>
            <code className="block break-all rounded-[8px] border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-primary">
              {link}
            </code>
          </Notice>
        ) : null}

        <p className="text-[12px] text-muted-soft">
          Email verification proves control of an address, not that a person votes once. Somebody with
          several addresses can still vote several times.
        </p>
      </div>
    </Panel>
  );
}
