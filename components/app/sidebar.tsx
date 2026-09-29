"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid, CalendarDays, Plus, Settings2, Gavel, Users, FileUp, Images, Vote,
  ShieldCheck, BookOpen, BadgeCheck, LogOut, Menu, X,
} from "lucide-react";
import { signOutAction } from "@/lib/actions/auth.ts";

// Icons travel as names: a server component cannot pass functions to a client one.
const ICONS = {
  dashboard: LayoutGrid, events: CalendarDays, create: Plus, organize: Settings2,
  judge: Gavel, team: Users, submit: FileUp, gallery: Images, vote: Vote,
  admin: ShieldCheck, docs: BookOpen, verify: BadgeCheck,
} as const;
export type IconName = keyof typeof ICONS;

export type NavItem = { href: string; label: string; icon: IconName; badge?: number };
export type NavGroup = { label?: string; items: NavItem[] };

/** The item whose href is the longest prefix of the current path wins. */
function activeHref(pathname: string, groups: NavGroup[]): string | null {
  let best: string | null = null;
  for (const g of groups) for (const it of g.items) {
    const hit = pathname === it.href || pathname.startsWith(it.href + "/");
    if (hit && (!best || it.href.length > best.length)) best = it.href;
  }
  return best;
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand">
        <span className="font-mono text-sm font-bold text-black">F</span>
      </span>
      <span className="text-[17px] font-semibold tracking-tight">Forgeboard</span>
    </Link>
  );
}

function Nav({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = activeHref(pathname, groups);
  return (
    <nav aria-label="App" className="flex flex-col gap-5">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.label ? (
            <p className="mb-1.5 truncate px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{g.label}</p>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {g.items.map((it) => {
              const Icon = ICONS[it.icon];
              const on = it.href === active;
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    aria-current={on ? "page" : undefined}
                    // Selected is the brand green; pressing anything is still black.
                    className={`group relative flex h-10 items-center gap-3 rounded-full px-3 text-sm transition-colors ${
                      on
                        ? "bg-brand-soft font-medium text-brand-ink"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground active:bg-foreground active:text-background"
                    }`}
                  >
                    {on ? (
                      <span aria-hidden className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand" />
                    ) : null}
                    <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden />
                    <span className="truncate">{it.label}</span>
                    {it.badge ? (
                      <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                        on ? "bg-brand text-black" : "bg-brand-soft text-brand-ink"
                      }`}>
                        {it.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function UserCard({ name, detail }: { name: string; detail: string }) {
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-secondary p-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <form action={signOutAction}>
        <button
          type="submit"
          aria-label="Sign out"
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground active:bg-foreground active:text-background"
        >
          <LogOut className="h-4 w-4" aria-hidden />
        </button>
      </form>
    </div>
  );
}

export function Sidebar({ groups, user }: { groups: NavGroup[]; user: { name: string; detail: string } }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [pathname]);

  /**
   * Drawer keyboard behaviour: Escape closes it, Tab stays inside it while it
   * covers the page, and focus goes in when it opens and back to the button
   * that opened it when it closes.
   */
  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    const focusable = () => Array.from(
      drawer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => el.offsetParent !== null);

    focusable()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !drawer?.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      toggleRef.current?.focus();
    };
  }, [open]);

  const body = (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      <Brand />
      <div className="flex-1"><Nav groups={groups} onNavigate={() => setOpen(false)} /></div>
      <UserCard {...user} />
    </div>
  );

  return (
    <>
      {/* Desktop: a floating white panel. */}
      <aside className="fixed inset-y-3 left-3 z-40 hidden w-64 rounded-3xl border border-border bg-card lg:block">
        {body}
      </aside>

      {/* Mobile: a top bar and a drawer. */}
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-card/90 px-4 backdrop-blur lg:hidden">
        <Brand />
        <button
          type="button"
          ref={toggleRef}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="app-drawer"
          aria-label={open ? "Close menu" : "Open menu"}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-secondary active:bg-foreground active:text-background"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button aria-label="Close menu" className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside
            id="app-drawer" ref={drawerRef} aria-label="Menu"
            className="absolute inset-y-0 left-0 w-72 bg-card shadow-xl"
          >
            {body}
          </aside>
        </div>
      ) : null}
    </>
  );
}

/** For visitors who are not signed in: a light bar instead of a sidebar. */
export function PublicBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-8">
        <Brand />
        <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
          <Link href="/events" className="rounded-full px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground">Events</Link>
          <Link href="/docs" className="rounded-full px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground">Docs</Link>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/signin" className="rounded-full px-3 py-2 text-sm font-medium hover:bg-secondary active:bg-foreground active:text-background">Sign in</Link>
          <Link href="/register" className="inline-flex h-9 items-center rounded-full bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/85">
            Create account
          </Link>
        </div>
      </div>
    </header>
  );
}
