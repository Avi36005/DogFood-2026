"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Pill tabs: the current one is black, the rest are quiet until hovered. */
export function PillTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  // Longest matching href wins, so a sub-page lights its own tab, not Overview.
  const active = tabs
    .filter((t) => pathname === t.href || pathname.startsWith(t.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label="Sections" className="flex gap-1.5 overflow-x-auto pb-1">
      {tabs.map((t) => {
        const on = t.href === active;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={`whitespace-nowrap rounded-full border px-4 py-2 text-[13px] font-medium transition-colors ${
              on
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-muted-foreground hover:text-foreground active:bg-foreground active:text-background"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
