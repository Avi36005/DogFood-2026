"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AsciiCube } from "./ascii-cube";

// Animated ASCII generators, in the reference's own style.
const asciiAnimations = {
  // Event setup: an event moving through its phases.
  phases: (frame: number) => {
    const arrows = ["─", "═", "━", "═"];
    const pulse = ["►", "▸", "▹", "▸"];
    const a = arrows[frame % arrows.length];
    const p = pulse[frame % pulse.length];
    return `  ┌─┐   ┌─┐
  │A├${a}${a}${p}│B│
  └─┘   └┬┘
        ┌▼┐
        │C│
        └─┘`;
  },
  // Team formation: seats filling as people accept an invite.
  team: (frame: number) => {
    const states = ["◉", "◎", "○", "◎"];
    const getChar = (offset: number) => states[(frame + offset) % states.length];
    return `  ┌───────┐
  │ ${getChar(0)} ${getChar(1)} ${getChar(2)} │
  │ ${getChar(3)} ${getChar(4)} ${getChar(5)} │
  │ ${getChar(6)} ${getChar(7)} ${getChar(8)} │
  └───────┘`;
  },
  // Project submissions: a draft going in.
  submit: (frame: number) => {
    const verbs = ["SAVE", "SAVE", "POST", "SAVE"];
    const arrows = ["────────►", "═══════►", "━━━━━━━►", "────────►"];
    const v = verbs[frame % verbs.length];
    const a = arrows[frame % arrows.length];
    return `  ${v} /draft
  ${a}
  ◄────────
  { v${(frame % 9) + 1} }`;
  },
  // Focused judging: isolation, drawn as the reference's lock.
  judging: (frame: number) => {
    const lock = ["◈", "◇", "◆", "◇"];
    const bars = ["░", "▒", "▓", "▒"];
    const l = lock[frame % lock.length];
    const b = bars[frame % bars.length];
    return `   ╔═══╗
   ║ ${l} ║
  ┌╨───╨┐
  │${b}${b}${b}${b}${b}│
  └─────┘`;
  },
  // Transparent scoring: raw against normalized.
  scoring: (frame: number) => {
    const heights = [
      [1, 2, 3, 2],
      [2, 3, 2, 3],
      [3, 2, 3, 1],
      [2, 1, 2, 2],
    ];
    const h = heights[frame % heights.length];
    const bar = (height: number) => {
      if (height === 3) return "█";
      if (height === 2) return "▄";
      return "▁";
    };
    return `  │${h[0] === 3 ? "▄" : " "}${h[1] === 3 ? "▄" : " "}${h[2] === 3 ? "▄" : " "}${h[3] === 3 ? "▄" : " "}
  │${bar(h[0])} ${bar(h[1])} ${bar(h[2])} ${bar(h[3])}
  │█ █ █ █
  └────────`;
  },
  // Self-hosted control: one box, running locally.
  server: (frame: number) => {
    const led = ["●", "○", "●", "●"];
    const l = led[frame % led.length];
    return `  ┌─────────┐
  │ ${l} ═══════ │
  ├─────────┤
  │ ${led[(frame + 1) % 4]} ═══════ │
  └────┬────┘
    ───┴───`;
  },
};

const features = [
  {
    title: "Event setup",
    description: "Dates, tracks, prizes and your own submission questions. Phases move on an explicit state machine, so an event cannot skip from draft to published results.",
    animationKey: "phases" as const,
  },
  {
    title: "Team formation",
    description: "One invite link and a seat limit the server actually enforces. Accepting is a single transaction, so two people cannot take the last seat.",
    animationKey: "team" as const,
  },
  {
    title: "Project submissions",
    description: "Draft freely and submit when ready. The deadline is checked on the server clock at the moment of writing, and every submit keeps a revision.",
    animationKey: "submit" as const,
  },
  {
    title: "Focused judging",
    description: "Weighted rubrics, balanced assignment, and isolation enforced in the data layer. A judge cannot reach a peer's ballot by editing a URL.",
    animationKey: "judging" as const,
  },
  {
    title: "Transparent scoring",
    description: "Cross-judge normalization with the method written down. Raw and adjusted ranks side by side, so the correction is visible rather than asserted.",
    animationKey: "scoring" as const,
  },
  {
    title: "Self-hosted control",
    description: "One command, a seeded database, no cloud account and no API key. It starts with the network switched off.",
    animationKey: "server" as const,
  },
];

function AnimatedAscii({ animationKey }: { animationKey: keyof typeof asciiAnimations }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    // Respect reduced motion: show the first frame and stop there.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = setInterval(() => {
      setFrame((f) => f + 1);
    }, 400);
    return () => clearInterval(interval);
  }, []);

  const getAscii = useCallback(() => {
    return asciiAnimations[animationKey](frame);
  }, [animationKey, frame]);

  return (
    <pre aria-hidden className="font-mono text-xs text-primary leading-tight whitespace-pre">
      {getAscii()}
    </pre>
  );
}

function FeatureCard({
  feature,
  index,
}: {
  feature: (typeof features)[0];
  index: number;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.2 }
    );

    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={cardRef}
      className={`group relative rounded-xl p-8 card-shadow transition-all duration-700 hover:border-primary/50 bg-transparent border-0 border-none border-transparent ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
      }`}
      style={{ transitionDelay: `${index * 100}ms` }}
    >
      {/* Animated ASCII Icon */}
      <div className="mb-6 h-20 flex items-center">
        <AnimatedAscii animationKey={feature.animationKey} />
      </div>

      {/* Content */}
      <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {feature.description}
      </p>
    </div>
  );
}

export function FeaturesSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      id="features"
      ref={sectionRef}
      className="relative py-32 overflow-hidden"
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        {/* Header with ASCII cube */}
        <div className="grid lg:grid-cols-2 gap-16 items-center mb-20">
          <div>
            <p className="text-sm font-mono text-primary mb-3">// PLATFORM</p>
            <h2
              className={`text-3xl lg:text-5xl font-semibold tracking-tight mb-6 transition-all duration-700 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              }`}
            >
              <span className="text-balance">Everything you need</span>
              <br />
              <span className="text-balance">to run the event.</span>
            </h2>
            <p
              className={`text-lg text-muted-foreground leading-relaxed max-w-lg transition-all duration-700 delay-100 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              }`}
            >
              Registration, teams, submissions, assignment, scoring and results, in one schema.
              Nothing to reconcile by hand on Sunday night.
            </p>
          </div>

          {/* ASCII Cube visualization */}
          <div className="flex justify-center lg:justify-end" aria-hidden>
            <AsciiCube className="w-[480px] h-[640px]" />
          </div>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
