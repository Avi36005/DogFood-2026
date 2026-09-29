"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { AsciiTorus } from "./ascii-torus";
import { Reveal, useInView } from "./motion";
import { UNIT_TESTS_PASSING } from "@/lib/release-facts.ts";

const securityFeatures = [
  {
    title: "Hashed credentials",
    description: "scrypt for passwords; only hashes are stored for sessions, invites and API keys",
    ascii: `  ╔═══╗
  ║ ◈ ║
  ╚═══╝`
  },
  {
    title: "Checked on every request",
    description: "Permissions are resolved from the database each time, never trusted from the browser",
    ascii: `  ┌───┐
  │ ✓ │
  └───┘`
  },
  {
    title: "Signed records",
    description: "Ed25519 participation records anyone can verify without an account",
    ascii: `  ╭───╮
  │ ★ │
  ╰───╯`
  },
  {
    title: "Minimal exports",
    description: "Bundles leave out password hashes, sessions and raw tokens",
    ascii: `  [===]
  [===]`
  },
  {
    title: "Per-event roles",
    description: "Organize one event, judge another and compete in a third",
    ascii: `  ◉─◉─◉
  │ │ │`
  },
  {
    title: "Audit trail",
    description: "Every change and every refused attempt, readable in the console",
    ascii: `  ▪ ▪ ▪
  ▪ ▪ ▪`
  },
];

// The reference listed certifications this project does not hold. These slots
// carry checks that were actually run; transcripts are in VERIFICATION.md.
const certifications = [
  { name: `${UNIT_TESTS_PASSING} tests`, status: "Passing" },
  { name: "Offline", status: "Verified" },
  { name: "Isolation", status: "Tested over HTTP" },
  { name: "MIT", status: "Licence" },
];

export function SecuritySection() {
  const [sectionRef, isVisible] = useInView<HTMLElement>(0.1);

  return (
    <section id="security" ref={sectionRef} className="relative py-32 bg-muted/30 overflow-hidden">
      {/* ASCII Torus Background */}
      <div className="absolute right-0 bottom-0 opacity-5 pointer-events-none">
        <AsciiTorus className="w-[500px] h-[450px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <Reveal show={isVisible} from="up" delay={0}>
            <p className="text-sm font-mono text-primary mb-4">// SECURITY</p>
          </Reveal>
          <Reveal show={isVisible} from="blur" delay={100}>
            <h2 className="text-4xl lg:text-5xl font-semibold tracking-tight mb-6 text-balance">
              Security you can inspect.
            </h2>
          </Reveal>
          <Reveal show={isVisible} from="up" delay={220}>
          <p className="text-lg text-muted-foreground leading-relaxed">
            No hosted auth provider and no third-party data processor. Every control below
            lives in the repository, with a test that exercises it.
          </p>
          </Reveal>
        </div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {securityFeatures.map((feature, index) => (
            <Reveal key={feature.title} show={isVisible} from="up" delay={300 + index * 110}>
            <div className="group h-full bg-card rounded-xl p-6 border border-border card-shadow transition-all duration-300 hover:border-primary/50 hover:-translate-y-1">
              {/* ASCII Icon: flickers on like a terminal booting */}
              <pre
                className={`font-mono text-sm text-primary mb-4 leading-tight h-12 flex items-center transition-transform duration-300 group-hover:translate-x-1 ${isVisible ? "fb-flicker" : "opacity-0"}`}
                style={{ animationDelay: `${450 + index * 110}ms` }}
              >
                {feature.ascii}
              </pre>

              <h3 className="font-semibold mb-2">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </div>
            </Reveal>
          ))}
        </div>

        {/* Certifications Bar */}
        <Reveal show={isVisible} from="up" delay={950}>
        <div className="rounded-xl bg-card border border-border card-shadow p-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div>
              <h3 className="font-semibold text-lg mb-2">Verified, not certified</h3>
              <p className="text-sm text-muted-foreground">
                Checks we actually ran, with transcripts in the repository
              </p>
            </div>

            <div className="flex flex-wrap gap-4 justify-center md:justify-end">
              {certifications.map((cert, i) => (
                <div
                  key={cert.name}
                  className={`flex flex-col items-center gap-2 px-6 py-4 rounded-lg bg-muted/50 border border-border transition-colors duration-300 hover:border-primary/50 ${isVisible ? "fb-pop" : "opacity-0"}`}
                  style={{ animationDelay: `${1150 + i * 140}ms` }}
                >
                  <span className="font-mono text-xs text-primary">{cert.name}</span>
                  <span className="text-xs text-muted-foreground">{cert.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        </Reveal>

        {/* Security Notice */}
        <Reveal show={isVisible} from="up" delay={1300}>
        <div className="mt-8 p-6 rounded-xl bg-foreground/5 border border-primary/20">
          <div className="flex items-start gap-4">
            <span className={`text-primary mt-1 ${isVisible ? "fb-wiggle" : ""}`} style={{ animationDelay: "1900ms" }}><Lock className="h-7 w-7" aria-hidden /></span>
            <div>
              <h4 className="font-semibold mb-2">A written threat model</h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Sybil voting, ballot stuffing, deadline gaming and judge collusion, including the
                attacks this does not stop.
                <Link href="/docs" className="text-primary hover:underline ml-1">Learn more →</Link>
              </p>
            </div>
          </div>
        </div>
        </Reveal>
      </div>
    </section>
  );
}
