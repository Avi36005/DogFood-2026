"use client";

import { useEffect, useState } from "react";
import { AsciiWave } from "./ascii-wave";
import { Reveal, CountUp, useInView, useCycle } from "./motion";

export type ProgressData = {
  submitted: number;
  drafts: number;
  reviewsDone: number;
  reviewsAssigned: number;
  judges: number;
  tracks: number;
  healthy: boolean;
  activity: { time: string; event: string; region: string; status: string; latency: string }[];
};

// The reference animated invented infrastructure numbers. These are this
// instance's own counts, read when the page renders. Each bar shows a real ratio.
function toMetrics(d: ProgressData) {
  const coverage = d.reviewsAssigned ? Math.round((100 * d.reviewsDone) / d.reviewsAssigned) : 0;
  const ratio = (a: number, b: number) => (b > 0 ? Math.min(1, a / b) : 0);
  return [
    { value: d.submitted, suffix: "", label: "Projects submitted", sublabel: `${d.drafts} still drafting`, bar: ratio(d.submitted, d.submitted + d.drafts) },
    { value: d.reviewsDone, suffix: "", label: "Reviews completed", sublabel: `of ${d.reviewsAssigned} assigned`, bar: ratio(d.reviewsDone, d.reviewsAssigned) },
    { value: coverage, suffix: "%", label: "Review coverage", sublabel: "submitted over assigned", bar: coverage / 100 },
    { value: d.judges, suffix: "", label: "Judges on the panel", sublabel: `across ${d.tracks} tracks`, bar: null as number | null },
  ];
}

export function MetricsSection({ data }: { data: ProgressData }) {
  const metrics = toMetrics(data);
  const [time, setTime] = useState<Date | null>(null);
  const [sectionRef, isVisible] = useInView<HTMLElement>(0.15);
  const active = useCycle(data.activity.length, 1600, isVisible);

  useEffect(() => {
    setTime(new Date());
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section id="progress" ref={sectionRef} className="relative py-32 overflow-hidden">
      {/* ASCII Wave Background */}
      <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none" aria-hidden>
        <AsciiWave className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-16">
          <div>
            <Reveal show={isVisible} from="up" delay={0}>
              <p className="text-sm font-mono text-primary mb-3">// EVENT PROGRESS</p>
            </Reveal>
            <Reveal show={isVisible} from="blur" delay={100}>
              <h2 className="text-3xl lg:text-5xl font-semibold tracking-tight text-balance">
                Live event<br />progress.
              </h2>
            </Reveal>
          </div>
          <Reveal show={isVisible} from="right" delay={250}>
            <div className="flex items-center gap-3 font-mono text-sm text-muted-foreground">
              <span className={`w-2 h-2 rounded-full animate-pulse ${data.healthy ? "bg-green-500" : "bg-yellow-500"}`} />
              <span>{data.healthy ? "Database reachable" : "Database check failed"}</span>
              <span className="text-border">|</span>
              <span className="tabular-nums">{time ? time.toLocaleTimeString() : "--:--:--"}</span>
            </div>
          </Reveal>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden card-shadow">
          {metrics.map((metric, i) => (
            <div key={metric.label} className="bg-card">
              <Reveal show={isVisible} from="up" delay={200 + i * 120} className="p-8 flex flex-col gap-4 h-full">
                <div className="text-primary font-mono text-4xl lg:text-6xl font-semibold tracking-tight">
                  <CountUp value={metric.value} suffix={metric.suffix} show={isVisible} duration={2000} />
                </div>
                <div>
                  <div className="text-foreground font-medium">{metric.label}</div>
                  <div className="text-sm text-muted-foreground">{metric.sublabel}</div>
                </div>

                {/* A real ratio, filling once the section is on screen. */}
                {metric.bar !== null ? (
                  <div className="mt-auto h-1 w-full overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-[1600ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                      style={{ width: isVisible ? `${Math.round(metric.bar * 100)}%` : "0%", transitionDelay: `${500 + i * 120}ms` }}
                    />
                  </div>
                ) : (
                  // Judges: one dot per track, popping in turn.
                  <div className="mt-auto flex gap-1.5" aria-hidden>
                    {Array.from({ length: Math.min(data.tracks, 12) }).map((_, t) => (
                      <span
                        key={t}
                        className={`h-1.5 w-1.5 rounded-full bg-primary/70 ${isVisible ? "fb-pop" : "opacity-0"}`}
                        style={{ animationDelay: `${700 + t * 80}ms` }}
                      />
                    ))}
                  </div>
                )}
              </Reveal>
            </div>
          ))}
        </div>

        {/* Activity Feed: rows slide in, then a highlight steps through them */}
        <Reveal show={isVisible} from="up" delay={650}>
          <div className="mt-12 p-6 rounded-xl bg-card border border-border card-shadow">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="font-mono text-sm text-muted-foreground">Recent public activity</span>
            </div>
            <div className="font-mono text-xs space-y-1 text-muted-foreground">
              {data.activity.length === 0 ? (
                <div className="text-muted-soft">Nothing public has happened yet.</div>
              ) : data.activity.map((a, i) => (
                <Reveal key={i} show={isVisible} from="left" delay={850 + i * 110}>
                  <ActivityLine {...a} highlighted={i === active} />
                </Reveal>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function ActivityLine({ time, event, region, status, latency, highlighted }: {
  time: string;
  event: string;
  region: string;
  status: string;
  latency: string;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-4 rounded-md px-2 py-1 transition-colors duration-500 ${
        highlighted ? "bg-primary/10" : "bg-transparent"
      }`}
    >
      <span className="text-muted-foreground/50 w-8">{time}</span>
      <span className="text-foreground">{event}</span>
      <span className="text-muted-foreground/50">{region}</span>
      <span className={status.startsWith("2") || status === "ok" ? "text-green-500" : "text-yellow-500"}>{status}</span>
      <span className="text-primary">{latency}</span>
    </div>
  );
}
