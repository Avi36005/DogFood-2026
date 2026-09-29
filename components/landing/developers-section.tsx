"use client";

import { useState } from "react";
import { Highlighted } from "./code-highlight";
import { Reveal, TypeText, useInView } from "./motion";
import { Copy, Check } from "lucide-react";

// Real commands for this repository. The reference showed an SDK that does not
// exist; there is no Forgeboard SDK, so none is shown.
const codeExamples = [
  {
    label: "Docker",
    code: `# one command, seeded, works offline
git clone <your-fork> forgeboard
cd forgeboard
docker compose up`,
  },
  {
    label: "Local",
    code: `# Node 24+, no database server needed
npm install
npm run db:migrate
npm run db:seed
npm run dev`,
  },
  {
    label: "API",
    code: `# the public gallery; no key required
curl "localhost:3000/api/v1/events/\
autumn-build-2026/projects?limit=2"`,
  },
];

const features = [
  { 
    title: "One command", 
    description: "docker compose up brings the portal up seeded; once the image is built, healthy in about two seconds."
  },
  { 
    title: "Runs offline", 
    description: "Verified in a container with no network at all. Fonts and assets are bundled."
  },
  { 
    title: "Portable by design", 
    description: "Export CSV at every stage, or the whole event as one JSON bundle you can import into another instance."
  },
  { 
    title: "MIT licensed", 
    description: "Fork it, run it, change it. No account, no key, no call home."
  },
];

export function DevelopersSection() {
  const [activeTab, setActiveTab] = useState(0);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeExamples[activeTab].code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const [sectionRef, isVisible] = useInView<HTMLElement>(0.12);

  return (
    <section id="open-source" ref={sectionRef} className="relative py-32 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-start">
          {/* Left: Content */}
          <div>
            <Reveal show={isVisible} from="left" delay={0}>
              <p className="text-sm font-mono text-primary mb-3">// OPEN SOURCE</p>
            </Reveal>
            <Reveal show={isVisible} from="blur" delay={100}>
              <h2 className="text-3xl lg:text-5xl font-semibold tracking-tight mb-6 text-balance">
                Yours to run,<br />one command.
              </h2>
            </Reveal>
            <Reveal show={isVisible} from="left" delay={200}>
              <p className="text-lg text-muted-foreground mb-10 leading-relaxed">
                No cloud account, no managed database, no auth provider, no runtime API key.
                Clone it, start it, and it is yours.
              </p>
            </Reveal>
            
            {/* Features list */}
            <div className="grid gap-6">
              {features.map((feature, i) => (
                <Reveal key={feature.title} show={isVisible} from="left" delay={320 + i * 130}>
                  <div className="group flex gap-4">
                    <div
                      className={`w-1 bg-primary/30 rounded-full shrink-0 transition-colors duration-300 group-hover:bg-primary ${isVisible ? "fb-grow-y" : "scale-y-0"}`}
                      style={{ animationDelay: `${500 + i * 130}ms` }}
                    />
                    <div className="transition-transform duration-300 group-hover:translate-x-1">
                      <h3 className="font-medium mb-1">{feature.title}</h3>
                      <p className="text-sm text-muted-foreground">{feature.description}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
            
            {/* ASCII DNA decoration */}
            
          </div>
          
          {/* Right: Code block */}
          <Reveal show={isVisible} from="right" delay={250} className="lg:sticky lg:top-32">
            <div className="rounded-xl overflow-hidden bg-card border border-border card-shadow">
              {/* Tabs */}
              <div className="flex items-center gap-1 p-2 border-b border-border bg-secondary/30">
                {codeExamples.map((example, idx) => (
                  <button
                    key={example.label}
                    type="button"
                    onClick={() => setActiveTab(idx)}
                    className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors ${
                      activeTab === idx
                        ? "bg-card text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {example.label}
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-2 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Copy code"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
              
              {/* Code content */}
              <div className="p-6 font-mono text-sm overflow-x-auto">
                <pre className="text-muted-foreground">
                  <code>
                    {codeExamples[activeTab].code.split('\n').map((line, i) => (
                      <div
                        key={`${activeTab}-${i}`}
                        className="leading-relaxed animate-in fade-in slide-in-from-left-2 fill-mode-both"
                        style={{ animationDelay: `${i * 70}ms`, animationDuration: "450ms" }}
                      >
                        <span className="text-muted-foreground/40 select-none w-8 inline-block">{i + 1}</span>
                        <Highlighted line={line} />
                      </div>
                    ))}
                  </code>
                </pre>
              </div>
              
              {/* Terminal output */}
              <div className="border-t border-border p-4 bg-secondary/20">
                <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground mb-2">
                  <span className="text-green-500">$</span>
                  <TypeText text="docker compose up" show={isVisible} delay={900} speed={55} />
                </div>
                <div
                  className={`text-xs font-mono text-muted-soft ${isVisible ? "animate-in fade-in fill-mode-both" : "opacity-0"}`}
                  style={{ animationDelay: "2000ms", animationDuration: "600ms" }}
                >
                  forgeboard  | listening on http://localhost:3000
                </div>
              </div>
            </div>
            
            {/* Docs link */}
            <div className="mt-6 flex items-center gap-4 text-sm">
              <a href="/docs" className="text-primary hover:underline font-mono">
                Read the docs
              </a>
              <span className="text-border">|</span>
              <a href="/api/v1/openapi.json" className="text-muted-foreground hover:text-foreground font-mono">
                OpenAPI spec
              </a>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
