"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, CircleDot, Search } from "lucide-react";

export type QueueEntry = {
  assignmentId: string; projectName: string; tagline: string;
  trackName: string | null; state: "done" | "draft" | "new";
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "new", label: "Not started" },
  { key: "draft", label: "In progress" },
  { key: "done", label: "Submitted" },
] as const;

const ICON = { done: CheckCircle2, draft: CircleDot, new: Circle };
const TONE = { done: "text-success", draft: "text-warning", new: "text-muted-soft" };

/**
 * The judge's own queue, beside the project they are reading. Only assignments
 * that belong to this judge are ever in it — the filtering here is for their
 * convenience, not a security boundary; the server decides what the list can
 * contain.
 */
export function JudgeRail({ slug, items, currentId }: {
  slug: string; items: QueueEntry[]; currentId: string;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [q, setQ] = useState("");

  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => {
    if (filter !== "all" && i.state !== filter) return false;
    if (needle && !`${i.projectName} ${i.tagline} ${i.trackName ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const done = items.filter((i) => i.state === "done").length;

  return (
    <nav aria-label="Your review queue" className="lg:sticky lg:top-24">
      <div className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-foreground">Your queue</span>
            <span className="font-mono tabular-nums text-[12px] text-muted-foreground">{done}/{items.length}</span>
          </div>
          <div className="relative mt-2">
            <Search size={13} aria-hidden className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-soft" />
            <input
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder="Search your queue"
              aria-label="Search your queue"
              className="min-h-[36px] w-full rounded-[8px] border border-control-border bg-background pl-7 pr-2 text-[12px] text-foreground placeholder:text-muted-soft"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`rounded-full px-2 py-1 text-[11px] transition-colors ${
                  filter === f.key
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-4 text-[12px] text-muted-soft">
            {items.length === 0 ? "Nothing is assigned to you yet." : "Nothing in your queue matches that."}
          </p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-border/60 overflow-y-auto">
            {shown.map((i) => {
              const Icon = ICON[i.state];
              const current = i.assignmentId === currentId;
              return (
                <li key={i.assignmentId}>
                  <Link
                    href={`/events/${slug}/judge/${i.assignmentId}`}
                    aria-current={current ? "page" : undefined}
                    className={`flex items-start gap-2 px-4 py-2.5 text-[12.5px] hover:bg-secondary ${
                      current ? "border-l-2 border-primary bg-secondary/70 font-medium text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <Icon size={14} aria-hidden className={`mt-0.5 shrink-0 ${TONE[i.state]}`} />
                    <span className="min-w-0">
                      <span className="block truncate">{i.projectName}</span>
                      {i.trackName ? <span className="block truncate text-[11px] text-muted-soft">{i.trackName}</span> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
