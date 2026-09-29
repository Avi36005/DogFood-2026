"use client";

import Link from "next/link";
import { Reveal, useInView } from "./motion";
import { Terminal } from "lucide-react";

// Only destinations that exist. The reference linked Careers, Blog, Status and
// Legal pages to "#"; a footer should not promise pages that are not there.
const footerLinks = {
  Product: [
    { name: "Platform", href: "/#features" },
    { name: "How it works", href: "/#how-it-works" },
    { name: "Judging", href: "/#judging" },
    { name: "Events", href: "/events" },
  ],
  Developers: [
    { name: "Documentation", href: "/docs" },
    { name: "API spec", href: "/api/v1/openapi.json" },
    { name: "Health check", href: "/api/health" },
    { name: "Verify a record", href: "/verify" },
  ],
  Account: [
    { name: "Sign in", href: "/signin" },
    { name: "Create account", href: "/register" },
    { name: "Dashboard", href: "/dashboard" },
    { name: "Create an event", href: "/events/new" },
  ],
};

export function FooterSection() {
  const [ref, isVisible] = useInView<HTMLElement>(0.1);
  return (
    <footer ref={ref} className="relative border-t border-border">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        {/* Main Footer */}
        <div className="py-16">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
            {/* Brand Column */}
            <Reveal show={isVisible} from="left" delay={0} className="col-span-2">
              {/* Logo */}
              <Link href="/" className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Terminal className="w-4 h-4 text-primary" />
                </div>
                <span className="font-semibold text-lg tracking-tight">forgeboard</span>
              </Link>

              <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                An open-source platform for hackathon submissions, judging and results.
              </p>

              <p className="font-mono text-xs text-muted-soft">From first commit to final verdict.</p>
            </Reveal>

            {/* Link Columns */}
            {Object.entries(footerLinks).map(([title, links], col) => (
              <Reveal key={title} show={isVisible} from="up" delay={120 + col * 110}>
                <h3 className="text-sm font-medium mb-4">{title}</h3>
                <ul className="space-y-3">
                  {links.map((link) => (
                    <li key={link.name}>
                      <Link
                        href={link.href}
                        className="inline-block text-sm text-muted-foreground hover:text-foreground hover:translate-x-0.5 transition-all duration-200"
                      >
                        {link.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="py-6 border-t border-border flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            © 2026 Forgeboard contributors · MIT licence
          </p>

          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Self-hosted · no outbound calls
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
