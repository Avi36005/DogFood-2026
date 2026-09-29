"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export type Progress = {
  teams: number; submitted: number; drafts: number; disqualified: number;
  assigned: number; reviews: number; judges: number; judgesNotStarted: number;
  short: number; at: string;
};

const INTERVAL_MS = 20_000;
const BACKOFF_MS = 60_000;

/**
 * The organizer's live numbers.
 *
 * Bounded polling: one request every twenty seconds, only while this tab is
 * visible, and a minute apart after a failure. The counts change only when the
 * server sends new ones — nothing here animates a number that has not moved —
 * and the strip always says when it last heard from the server, or that it did
 * not.
 */
export function LiveProgress({ slug, initial }: { slug: string; initial: Progress }) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const lastGood = useRef(initial.at);

  const poll = useCallback(async (manual = false) => {
    if (manual) setBusy(true);
    try {
      const res = await fetch(`/api/v1/events/${slug}/progress`, { cache: "no-store" });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      const body = (await res.json()) as { data: Progress };
      setStale(null);
      lastGood.current = body.data.at;
      setData((prev) => {
        const changed = (Object.keys(body.data) as (keyof Progress)[])
          .some((k) => k !== "at" && prev[k] !== body.data[k]);
        // The tables below are server-rendered, so a real change refreshes them too.
        if (changed) router.refresh();
        return body.data;
      });
    } catch (err) {
      setStale(err instanceof Error ? err.message : "no answer");
    } finally {
      if (manual) setBusy(false);
    }
  }, [slug, router]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await poll();
      if (stopped) return;
      timer = setTimeout(tick, stale ? BACKOFF_MS : INTERVAL_MS);
    };
    timer = setTimeout(tick, stale ? BACKOFF_MS : INTERVAL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [poll, stale]);

  const cells = [
    { v: data.teams, l: "teams" },
    { v: data.submitted, l: "submitted", s: `${data.drafts} still drafting${data.disqualified ? `, ${data.disqualified} disqualified` : ""}` },
    { v: data.reviews, l: "reviews submitted", s: `of ${data.assigned} assigned` },
    { v: data.short, l: "projects short of target", s: data.short ? "needs attention" : "fully covered" },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-border bg-border lg:grid-cols-4">
        {cells.map((c) => (
          <div key={c.l} className="bg-card px-5 py-5">
            <div className="font-mono tabular-nums text-[26px] leading-none text-foreground">{c.v}</div>
            <div className="mt-2 text-[13px] text-muted-foreground">{c.l}</div>
            {c.s ? <div className="mt-0.5 text-[12px] text-muted-soft">{c.s}</div> : null}
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]" aria-live="polite">
        {stale ? (
          <span className="text-warning">
            Not updating: {stale}. Showing the numbers from {lastGood.current.slice(11, 19)} UTC.
          </span>
        ) : (
          <span className="text-muted-soft">
            Updated {data.at.slice(11, 19)} UTC · refreshes every 20 seconds while this tab is open
          </span>
        )}
        <button
          type="button"
          onClick={() => poll(true)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-control-border px-3 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw size={12} aria-hidden className={busy ? "fb-spin" : ""} />
          {busy ? "Refreshing…" : "Refresh now"}
        </button>
      </div>
    </div>
  );
}
