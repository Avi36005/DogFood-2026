"use client";

import { useEffect, useRef, useState } from "react";
import { Highlighted } from "./code-highlight";

// Every command below runs against this product's real API.
const steps = [
  {
    number: "01",
    title: "Create your event",
    description: "Set the window, add tracks and prizes, write the questions you actually want answered.",
    file: "create-event.sh",
    code: `# you become the organizer of this event only
curl -X POST localhost:3000/api/v1/events \\
  -H "Authorization: Bearer fbk_…" \\
  -d '{"name": "Spring Build"}'`,
    result: "201 Created",
  },
  {
    number: "02",
    title: "Bring in the builds",
    description: "Teams form by invite, draft in their own time, and submit before the deadline the backend enforces.",
    file: "gallery.sh",
    code: `# submitted projects only; drafts never appear
curl "localhost:3000/api/v1/events/\\
spring-build/projects?q=offline&tag=rust"`,
    result: "200 OK",
  },
  {
    number: "03",
    title: "Review and publish",
    description: "Assign judges, score against a weighted rubric, normalize across the panel, then publish when you are ready.",
    file: "publish.sh",
    code: `# compute a private snapshot, then release it
curl -X POST localhost:3000/api/v1/events/\\
spring-build/results -H "Authorization: …"
curl -X POST localhost:3000/api/v1/events/\\
spring-build/publish -H "Authorization: …"`,
    result: "200 OK",
  },
];

export function HowItWorksSection() {
  const [activeStep, setActiveStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setReduceMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  // Auto-cycle through steps, unless the visitor prefers reduced motion.
  useEffect(() => {
    if (reduceMotion) return;
    const interval = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % steps.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [reduceMotion]);

  return (
    <section
      id="how-it-works"
      ref={sectionRef}
      className="relative py-32 overflow-hidden bg-secondary/30"
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        {/* Header */}
        <div className="mb-20">
          <p className="text-sm font-mono text-primary mb-3">// HOW IT WORKS</p>
          <h2
            className={`text-3xl lg:text-5xl font-semibold tracking-tight mb-6 transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            <span className="text-balance">Three steps to</span>
            <br />
            <span className="text-balance">a final verdict.</span>
          </h2>
        </div>

        {/* Main content */}
        <div className="grid lg:grid-cols-2 gap-16 items-start">
          {/* Steps list */}
          <div className="space-y-2">
            {steps.map((step, index) => (
              <button
                key={step.number}
                type="button"
                onClick={() => setActiveStep(index)}
                aria-pressed={activeStep === index}
                className={`w-full text-left p-6 rounded-xl border transition-all duration-300 ${
                  activeStep === index
                    ? "bg-card border-primary/50 card-shadow"
                    : "bg-transparent border-transparent hover:bg-card/50"
                }`}
              >
                <div className="flex items-start gap-4">
                  <span
                    className={`font-mono text-sm transition-colors ${
                      activeStep === index ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    {step.number}
                  </span>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold mb-1">{step.title}</h3>
                    <p
                      className={`text-sm leading-relaxed transition-colors ${
                        activeStep === index ? "text-muted-foreground" : "text-muted-soft"
                      }`}
                    >
                      {step.description}
                    </p>
                  </div>
                </div>

                {/* Progress bar */}
                {activeStep === index && !reduceMotion && (
                  <div className="mt-4 ml-8">
                    <div className="h-0.5 bg-border rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full animate-[progress_4s_linear]"
                        style={{ width: "100%" }}
                      />
                    </div>
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Code display */}
          <div className="lg:sticky lg:top-32">
            <div className="rounded-xl overflow-hidden bg-card border border-border card-shadow">
              {/* Window chrome */}
              <div className="px-4 py-3 border-b border-border flex items-center gap-3 bg-secondary/30">
                <div className="flex gap-1.5" aria-hidden>
                  <div className="w-3 h-3 rounded-full bg-muted-foreground/20" />
                  <div className="w-3 h-3 rounded-full bg-muted-foreground/20" />
                  <div className="w-3 h-3 rounded-full bg-muted-foreground/20" />
                </div>
                <span className="text-xs font-mono text-muted-foreground">{steps[activeStep].file}</span>
              </div>

              {/* Code content */}
              <div className="p-6 font-mono text-sm min-h-[200px] overflow-x-auto">
                <pre className="text-muted-foreground">
                  {steps[activeStep].code.split("\n").map((line, i) => (
                    <div
                      key={`${activeStep}-${i}`}
                      className="leading-relaxed animate-in fade-in slide-in-from-left-2"
                      style={{ animationDelay: `${i * 50}ms` }}
                    >
                      <span className="text-muted-foreground/40 select-none w-6 inline-block">{i + 1}</span>
                      <Highlighted line={line} />
                    </div>
                  ))}
                </pre>
              </div>

              {/* Output */}
              <div className="border-t border-border p-4 bg-secondary/20 font-mono text-xs">
                <div className="flex items-center gap-2 text-green-500">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  {steps[activeStep].result}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes progress {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </section>
  );
}
