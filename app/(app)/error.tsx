"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, Notice, Panel, PanelHeader } from "@/components/app/ui";

/**
 * What a visitor sees when a screen fails: what happened, what it did not
 * affect, and a way forward. The digest is shown because it is the one thing
 * that ties this screen to a line in the server log.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[forgeboard] screen failed to render", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-16 lg:px-8">
      <Panel>
        <PanelHeader title="This screen did not load" sub="Nothing you had already saved is affected." />
        <div className="space-y-5 px-6 py-6">
          <Notice tone="danger">
            {error.message || "The server did not return a usable response."}
          </Notice>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Try again — most failures here are momentary. If it keeps happening, the server log holds the
            full detail{error.digest ? <> under reference <code className="font-mono text-[12px]">{error.digest}</code></> : null}.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={reset}>Try again</Button>
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center rounded-full px-5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Back to the dashboard
            </Link>
          </div>
        </div>
      </Panel>
    </div>
  );
}
