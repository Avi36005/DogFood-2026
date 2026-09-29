"use client";

import Link from "next/link";
import { AsciiCube } from "./ascii-cube";
import { Reveal, TypeText, useInView } from "./motion";

const integrations = [
  { 
    name: "Webhooks", 
    category: "Signed events",
    ascii: `  ┌─┐
  │#│
  └─┘`
  },
  { 
    name: "Repository links", 
    category: "Submissions",
    ascii: `  ╔═╗
  ║<║
  ╚═╝`
  },
  { 
    name: "CSV export", 
    category: "Every stage",
    ascii: `  ┌$┐
  └─┘`
  },
  { 
    name: "SQLite", 
    category: "Database",
    ascii: `  [█]
  [█]`
  },
  { 
    name: "REST API", 
    category: "OpenAPI 3.1",
    ascii: `  ◈◈
  ◈◈`
  },
  { 
    name: "Docker", 
    category: "One command",
    ascii: `  ≋≋
  ≋≋`
  },
  { 
    name: "JSON bundle", 
    category: "Import & export",
    ascii: `  {M}
  ---`
  },
  { 
    name: "Embed", 
    category: "Gallery widget",
    ascii: `  ▲
  ─`
  },
];

export function IntegrationsSection() {
  const [sectionRef, isVisible] = useInView<HTMLElement>(0.1);

  return (
    <section id="integrations" ref={sectionRef} className="relative py-32 overflow-hidden">
      {/* ASCII Cube Background */}
      <div className="absolute left-10 top-1/3 opacity-5 pointer-events-none hidden xl:block">
        <AsciiCube className="w-[400px] h-[350px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <Reveal show={isVisible} from="up" delay={0}>
            <p className="text-sm font-mono text-primary mb-4">// INTEGRATIONS</p>
          </Reveal>
          <Reveal show={isVisible} from="blur" delay={100}>
            <h2 className="text-4xl lg:text-5xl font-semibold tracking-tight mb-6 text-balance">
              Get data in.<br />Get data out.
            </h2>
          </Reveal>
          <Reveal show={isVisible} from="up" delay={220}>
          <p className="text-lg text-muted-foreground leading-relaxed">
            A platform you cannot leave is a trap. Every stage exports, the event exports
            whole, and anything the organizer does can be pushed to your own systems.
          </p>
          </Reveal>
        </div>

        {/* Integrations Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          {integrations.map((integration, index) => (
            <Reveal key={integration.name} show={isVisible} from="scale" delay={300 + index * 70} duration={600}>
            <div className="group relative bg-card rounded-xl p-6 border border-border card-shadow hover:border-primary/50 hover:-translate-y-1 transition-all duration-300">
              {/* ASCII Icon, floating */}
              <pre
                className="fb-float font-mono text-lg text-primary mb-4 leading-tight h-12 flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
                style={{ animationDelay: `${index * 0.35}s` }}
              >
                {integration.ascii}
              </pre>
              
              <div className="text-center">
                <h3 className="font-semibold mb-1">{integration.name}</h3>
                <p className="text-xs text-muted-foreground">{integration.category}</p>
              </div>

              {/* Hover indicator */}
              <div className="absolute top-2 right-2 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300">
                <span className="text-primary font-mono text-xs">→</span>
              </div>
            </div>
            </Reveal>
          ))}
        </div>

        {/* CTA Card */}
        <Reveal show={isVisible} from="up" delay={850}>
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-card to-muted/50 border border-border card-shadow">
          <div className="relative z-10 p-8 lg:p-12">
            <div className="grid lg:grid-cols-2 gap-8 items-center">
              <div>
                <h3 className="text-2xl lg:text-3xl font-semibold mb-4">
                  Need a custom integration?
                </h3>
                <p className="text-muted-foreground mb-6">
                  The REST API shares the interface&rsquo;s authorization, so a key can do exactly
                  what its owner can. Webhooks are signed and delivered at least once.
                </p>
                <Link href="/api/v1/openapi.json" className="inline-block px-6 py-3 bg-foreground text-background rounded-lg font-medium hover:bg-foreground/90 transition-colors">
                  View API Docs
                </Link>
              </div>

              <div className="font-mono text-xs text-muted-foreground space-y-2 bg-background/50 rounded-lg p-6 border border-border">
                <div className="text-primary mb-2">
                  <TypeText text="// Example: a signed webhook delivery" show={isVisible} delay={1100} speed={18} caret={false} />
                </div>
                <Reveal show={isVisible} from="left" delay={1800} duration={500}>
                  <div>
                    <span className="text-purple-400">POST</span> /your-endpoint <span className="text-blue-400">X-Forgeboard-Signature</span> {'{'}
                  </div>
                </Reveal>
                <Reveal show={isVisible} from="left" delay={2000} duration={500}>
                  <div className="pl-4">
                    <span className="text-green-400">topic</span>: <span className="text-yellow-400">&quot;review.submitted&quot;</span>,
                  </div>
                </Reveal>
                <Reveal show={isVisible} from="left" delay={2200} duration={500}>
                  <div className="pl-4">
                    <span className="text-green-400">id</span>: <span className="text-yellow-400">&quot;dlv_… dedupe on this&quot;</span>
                  </div>
                </Reveal>
                <Reveal show={isVisible} from="left" delay={2400} duration={500}>
                  <div>{'}'}</div>
                </Reveal>
              </div>
            </div>
          </div>

          {/* Background Pattern */}
          <div className="absolute inset-0 opacity-5 grid-pattern pointer-events-none" />
        </div>
        </Reveal>
      </div>
    </section>
  );
}
