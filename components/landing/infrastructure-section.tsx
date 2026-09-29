"use client";

import { AsciiDna } from "./ascii-dna";
import { Reveal, CountUp, useInView } from "./motion";
import { Lock, ShieldCheck, Workflow } from "lucide-react";

// The reference listed invented data-centre regions. These cards show what each
// role can actually reach, enforced in the data layer. Dots = areas of access.
const regions = [
  { name: "Visitor", nodes: 1, latency: "gallery · results" },
  { name: "Participant", nodes: 2, latency: "own team · own draft" },
  { name: "Judge", nodes: 2, latency: "own queue · own scores" },
  { name: "Organizer", nodes: 5, latency: "one event, in full" },
  { name: "Admin", nodes: 3, latency: "accounts · instance" },
];

const points = [
  { icon: Lock, title: "Isolation in the query", body: "A judge’s queue is selected by ownership, so no URL returns a peer’s ballot" },
  { icon: Workflow, title: "Track and conflict checks", body: "Judges stay inside their track and never review their own team" },
  { icon: ShieldCheck, title: "A readable audit trail", body: "Every change and every refused attempt, readable without a database client" },
];

export type RoleCounts = { judges: number; organizers: number; participants: number };

export function InfrastructureSection({ counts }: { counts: RoleCounts }) {
  const [sectionRef, isVisible] = useInView<HTMLElement>(0.12);

  return (
    <section id="judging" ref={sectionRef} className="relative py-32 bg-muted/30 overflow-hidden">
      {/* ASCII DNA Background */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2 opacity-10 pointer-events-none" aria-hidden>
        <AsciiDna className="w-[600px] h-[500px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Left: Content, cascading in */}
          <div>
            <Reveal show={isVisible} from="left" delay={0}>
              <p className="text-sm font-mono text-primary mb-4">// JUDGING INTEGRITY</p>
            </Reveal>
            <Reveal show={isVisible} from="left" delay={90}>
              <h2 className="text-4xl lg:text-5xl font-semibold tracking-tight mb-6 text-balance">
                Every role sees exactly its share.
              </h2>
            </Reveal>
            <Reveal show={isVisible} from="left" delay={180}>
              <p className="text-lg text-muted-foreground leading-relaxed mb-8">
                Permissions are resolved from the database on every request and enforced
                where the data is read. Hiding a button is a courtesy; the query is the rule.
              </p>
            </Reveal>

            <div className="space-y-6">
              {points.map((p, i) => (
                <Reveal key={p.title} show={isVisible} from="left" delay={300 + i * 130}>
                  <div className="flex items-start gap-4 group/point">
                    <pre
                      className={`font-mono text-2xl text-primary transition-transform duration-300 group-hover/point:scale-125 ${isVisible ? "fb-pop" : "opacity-0"}`}
                      style={{ animationDelay: `${420 + i * 130}ms` }}
                    >
                      <p.icon className="h-5 w-5 text-primary" aria-hidden />
                    </pre>
                    <div>
                      <h3 className="font-semibold mb-1">{p.title}</h3>
                      <p className="text-sm text-muted-foreground">{p.body}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>

          {/* Right: role cards, with a permission check sweeping across them */}
          <div>
            <div className="relative grid grid-cols-1 gap-3">
              {/* The sweep: a thin line travelling down the stack, over and over. */}
              {isVisible ? (
                <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-lg">
                  <div className="fb-scan absolute inset-x-0 top-0 h-full">
                    <div className="h-px w-full bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
                    <div className="h-10 w-full bg-gradient-to-b from-primary/[0.07] to-transparent" />
                  </div>
                </div>
              ) : null}

              {regions.map((region, index) => (
                <Reveal key={region.name} show={isVisible} from="right" delay={200 + index * 110}>
                  <div className="group relative bg-card rounded-lg p-5 border border-border card-shadow hover:border-primary/50 hover:-translate-y-0.5 transition-all duration-300">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-semibold">{region.name}</h4>
                      <span className="font-mono text-xs text-primary">{region.latency}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        {Array.from({ length: region.nodes }).map((_, i) => (
                          // Each access dot pops in on its own, then keeps pulsing.
                          <span
                            key={i}
                            className={`w-2 h-2 rounded-full bg-primary/70 ${isVisible ? "fb-pop" : "opacity-0"}`}
                            style={{ animationDelay: `${600 + index * 110 + i * 90}ms` }}
                          >
                            <span className="block h-full w-full rounded-full bg-primary/70 animate-pulse" style={{ animationDelay: `${i * 200}ms` }} />
                          </span>
                        ))}
                      </div>
                      <span className="text-xs text-muted-foreground font-mono">
                        {region.nodes} {region.nodes === 1 ? "area" : "areas"} of access
                      </span>
                    </div>

                    {/* Animated ASCII Network Visualization */}
                    <div aria-hidden className="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-30 transition-opacity font-mono text-xs text-primary">
                      <pre>{`
  ┌───┐
  │ ◉ │
  └─┬─┘
    │
`}</pre>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>

            {/* Stats, counting up from zero */}
            <Reveal show={isVisible} from="up" delay={800}>
              <div className="mt-8 p-6 rounded-lg bg-foreground/5 border border-border">
                <div className="grid grid-cols-3 gap-4 text-center">
                  {[
                    { v: counts.judges, l: "Judges" },
                    { v: counts.organizers, l: "Organizers" },
                    { v: counts.participants, l: "Participants" },
                  ].map((s) => (
                    <div key={s.l}>
                      <div className="font-mono text-2xl font-semibold text-primary">
                        <CountUp value={s.v} show={isVisible} duration={1800} />
                      </div>
                      <div className="text-xs text-muted-foreground">{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
