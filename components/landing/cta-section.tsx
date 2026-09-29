"use client";

import Link from "next/link";
import { Reveal, useInView } from "./motion";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { AsciiCube } from "./ascii-cube";
import { AsciiSphere } from "./ascii-sphere";

export function CtaSection() {
  const [sectionRef, isVisible] = useInView<HTMLElement>(0.2);
  const words = "Your next hackathon starts here.".split(" ");

  return (
    <section id="get-started" ref={sectionRef} className="relative py-32 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div
          className={`relative rounded-2xl overflow-hidden transition-all duration-1000 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-10 scale-[0.96]"
          }`}
        >
          {/* Background with grid */}
          <div className="absolute inset-0 bg-foreground" />
          <div className="absolute inset-0 grid-pattern opacity-10" />
          
          {/* Cube animation as full background */}
          <div className="absolute right-0 top-1/2 -translate-y-1/2 overflow-hidden opacity-25">
            <AsciiCube className="w-[600px] h-[500px]" />
          </div>

          <div className="relative z-10 px-8 lg:px-16 py-16 bg-transparent lg:py-0.5">
            <div className="flex items-center justify-between gap-8">
              <div className="max-w-2xl">
                <h2 className="text-3xl lg:text-5xl font-semibold tracking-tight mb-6 text-background text-balance" aria-label="Your next hackathon starts here.">
                  {words.map((w, i) => (
                    <span key={i} aria-hidden className="inline-block overflow-hidden align-bottom">
                      <span
                        className={`inline-block transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${isVisible ? "translate-y-0" : "translate-y-full"}`}
                        style={{ transitionDelay: `${300 + i * 110}ms` }}
                      >
                        {w}{i < words.length - 1 ? "\u00a0" : ""}
                      </span>
                    </span>
                  ))}
                </h2>

                <Reveal show={isVisible} from="blur" delay={900}>
                <p className="text-lg text-background/70 mb-8 leading-relaxed max-w-lg">
                  Give every build a place and every review a clear process.
                </p>
                </Reveal>

                <Reveal show={isVisible} from="up" delay={1050}>
                <div className="flex flex-col sm:flex-row items-start gap-4">
                  <Button
                    asChild
                    size="lg"
                    className="bg-background hover:bg-background/90 text-foreground px-6 h-12 text-sm font-medium group"
                  >
                    <Link href="/events/new">
                      Create an event
                      <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="outline"
                    className="h-12 px-6 text-sm font-medium border-background/30 text-background hover:bg-background/10 bg-transparent"
                  >
                    <Link href="/events">Explore projects</Link>
                  </Button>
                </div>
                </Reveal>

                <Reveal show={isVisible} from="up" delay={1200}>
                <p className="text-sm text-background/50 mt-6 font-mono">
                  MIT licensed · self-hosted · runs offline
                </p>
                </Reveal>
              </div>
              
              {/* Animated ASCII Sphere */}
              <div className="hidden lg:block opacity-40">
                <AsciiSphere />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
