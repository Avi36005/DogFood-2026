"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight, FolderGit2, ClipboardCheck, Users, CalendarDays } from "lucide-react";
import { AsciiWave } from "./ascii-wave";

export type HeroStats = {
  events: number;
  projects: number;
  judges: number;
  reviews: number;
  seeded: boolean;
};

export function HeroSection({ stats }: { stats: HeroStats }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  // Every value here is a live database count. The reference showed invented
  // customer results; those are gone, and nothing replaces them with fiction.
  const strip = [
    { value: stats.projects, label: "Projects submitted", caption: "SUBMISSIONS", Icon: FolderGit2 },
    { value: stats.reviews, label: "Reviews completed", caption: "JUDGING", Icon: ClipboardCheck },
    { value: stats.judges, label: "Judges on the panel", caption: "PANEL", Icon: Users },
    { value: stats.events, label: stats.events === 1 ? "Event hosted" : "Events hosted", caption: "EVENTS", Icon: CalendarDays },
  ];
  // Dividers for a 2×2 grid on small screens and a single row on large ones.
  const divider = [
    "",
    "border-l",
    "border-t lg:border-t-0 lg:border-l",
    "border-l border-t lg:border-t-0",
  ];

  return (
    <section className="relative min-h-screen flex flex-col justify-center overflow-hidden pt-20">
      {/* Subtle grid */}
      <div className="absolute inset-0 grid-pattern opacity-50" />

      {/* ASCII Wave full width and height */}
      <div className="absolute inset-0 opacity-30 pointer-events-none overflow-hidden" aria-hidden>
        <AsciiWave className="w-full h-full" />
      </div>

      <div className="relative z-10 w-full max-w-7xl mx-auto px-6 lg:px-8 py-12 lg:py-24">
        {/* Headline */}
        <div className="text-center max-w-5xl mx-auto mb-10">
          <h1
            className={`text-5xl md:text-7xl font-semibold tracking-tight leading-[0.95] mb-8 transition-all duration-700 delay-100 lg:text-7xl ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
            style={{ fontFamily: "var(--font-geist-pixel-line), monospace" }}
          >
            <span className="text-balance">From first commit</span>
            <br />
            <span className="text-balance">to</span>{" "}
            <span className="text-primary">final verdict.</span>
          </h1>

          <p
            className={`text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            Run your hackathon from kickoff to results. Bring teams, submissions and judging
            into one focused workspace.
          </p>
        </div>

        {/* CTAs */}
        <div
          className={`flex flex-col sm:flex-row items-center justify-center gap-3 mb-20 transition-all duration-700 delay-300 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          {/* A matched pair: same height, padding and radius; solid and outlined. */}
          <Button
            asChild
            size="lg"
            className="h-12 rounded-xl px-7 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 group"
          >
            <Link href="/events/new">
              Create an event
              <ArrowRight className="w-4 h-4 ml-1 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            // Explicit dark: overrides, or shadcn's dark:border-input hides the edge.
            className="h-12 rounded-xl px-7 text-sm font-medium text-foreground border-white/15 bg-white/[0.04] backdrop-blur-sm hover:bg-white/[0.09] hover:border-white/30 hover:text-foreground dark:border-white/15 dark:bg-white/[0.04] dark:hover:bg-white/[0.09]"
          >
            <Link href="/events">Explore projects</Link>
          </Button>
        </div>

        {/* Live counts: frosted glass over the texture rather than a black slab. */}
        <div
          className={`transition-all duration-700 delay-400 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <div className="relative grid grid-cols-2 lg:grid-cols-4 overflow-hidden rounded-2xl border border-white/10 bg-card/55 backdrop-blur-xl">
            {strip.map((stat, i) => (
              <div
                key={stat.caption}
                className={`group relative flex min-h-[150px] flex-col justify-start gap-5 border-white/10 p-5 lg:p-8 transition-colors hover:bg-white/[0.03] ${divider[i]}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] tracking-[0.12em] lg:text-[11px] lg:tracking-[0.2em] text-muted-foreground">{stat.caption}</span>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                    <stat.Icon className="h-4 w-4 text-primary" aria-hidden />
                  </span>
                </div>
                <div>
                  <div className="text-3xl lg:text-4xl font-semibold tracking-tight tabular-nums text-foreground">
                    {stat.value.toLocaleString()}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">{stat.label}</div>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-4 flex items-center justify-center gap-2 font-mono text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden />
            {stats.seeded ? "Live counts from the demo event" : "Live counts from this instance"}
          </p>
        </div>
      </div>
    </section>
  );
}
