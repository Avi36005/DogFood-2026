"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

// Section anchors are absolute so the header works from every page, not only the landing.
const navLinks = [
  { name: "Platform", href: "/#features" },
  { name: "How it works", href: "/#how-it-works" },
  { name: "Judging", href: "/#judging" },
  { name: "Open source", href: "/#open-source" },
];

/**
 * Floating pill navigation.
 *
 * Dark by default so it sits in the theme; the whole bar turns white while the
 * pointer is over it (or keyboard focus is inside it), and the call-to-action
 * inverts from a white pill to a black one. Every colour change is driven by
 * the `group` on the pill, so the states always move together.
 */
export function Navigation({
  signedIn = false,
  displayName,
}: {
  signedIn?: boolean;
  displayName?: string;
  /** Kept for callers; the pill looks the same on every page. */
  solid?: boolean;
}) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Closing always hands focus back to the toggle, so it never rests on a link
  // that has just become inert.
  const closeMenu = () => {
    setIsMobileMenuOpen(false);
    toggleRef.current?.focus();
  };

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    // Opening moves focus to the first link, so the menu is reachable at once.
    menuRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobileMenuOpen]);

  const cta = signedIn
    ? { href: "/dashboard", label: "Dashboard" }
    : { href: "/events/new", label: "Create an event" };
  const secondary = signedIn
    ? { href: "/dashboard", label: displayName ?? "Account" }
    : { href: "/signin", label: "Sign in" };

  return (
    <header className="fixed inset-x-0 top-3 z-50 px-4">
      <nav
        aria-label="Main"
        className="group mx-auto flex h-12 max-w-5xl items-center justify-between rounded-full border border-white/[0.08] bg-white/[0.03] pl-2 pr-2 backdrop-blur-md transition-colors duration-300 ease-out hover:border-transparent hover:bg-white focus-within:border-transparent focus-within:bg-white"
      >
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 rounded-full pr-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <span className="font-mono text-[13px] font-semibold text-black">F</span>
          </span>
          <span className="text-[15px] font-medium tracking-tight text-white/90 transition-colors duration-300 group-hover:text-neutral-900 group-focus-within:text-neutral-900">
            Forgeboard
          </span>
        </Link>

        {/* Desktop links */}
        <div className="hidden items-center lg:flex">
          {navLinks.map((link) => (
            <a
              key={link.name}
              href={link.href}
              className="rounded-full px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-white/55 transition-colors duration-300 hover:text-white group-hover:text-neutral-500 group-hover:hover:text-neutral-900 group-focus-within:text-neutral-500 group-focus-within:hover:text-neutral-900"
            >
              {link.name}
            </a>
          ))}
        </div>

        {/* Desktop actions */}
        <div className="hidden items-center gap-1 lg:flex">
          <Link
            href={secondary.href}
            className="rounded-full px-3 py-1.5 text-[13px] text-white/70 transition-colors duration-300 hover:text-white group-hover:text-neutral-900 group-focus-within:text-neutral-900"
          >
            {secondary.label}
          </Link>
          <Link
            href={cta.href}
            className="inline-flex h-8 items-center rounded-full bg-white px-4 text-[13px] font-medium text-neutral-950 transition-colors duration-300 group-hover:bg-neutral-950 group-hover:text-white group-focus-within:bg-neutral-950 group-focus-within:text-white"
          >
            {cta.label}
          </Link>
        </div>

        {/* Mobile toggle */}
        <button
          ref={toggleRef}
          type="button"
          onClick={() => (isMobileMenuOpen ? closeMenu() : setIsMobileMenuOpen(true))}
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition-colors duration-300 group-hover:text-neutral-900 group-focus-within:text-neutral-900 lg:hidden"
          aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
          aria-expanded={isMobileMenuOpen}
          aria-controls="mobile-menu"
        >
          {isMobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </nav>

      {/* Mobile menu, a panel under the pill. Kept mounted so it can animate, but
          inert while closed: nothing inside is focusable or in the accessibility tree. */}
      <div
        id="mobile-menu"
        ref={menuRef}
        inert={!isMobileMenuOpen}
        aria-hidden={!isMobileMenuOpen}
        className={`mx-auto mt-2 max-w-5xl overflow-hidden rounded-2xl border border-white/[0.08] bg-background/90 backdrop-blur-md transition-all duration-300 motion-reduce:transition-none lg:hidden ${
          isMobileMenuOpen ? "max-h-[520px] opacity-100" : "pointer-events-none max-h-0 border-transparent opacity-0"
        }`}
      >
        <div className="flex flex-col gap-1 p-3">
          {navLinks.map((link) => (
            <a
              key={link.name}
              href={link.href}
              onClick={closeMenu}
              className="rounded-2xl px-4 py-3 text-[13px] font-medium uppercase tracking-[0.16em] text-white/70 transition-colors hover:bg-white/5 hover:text-white"
            >
              {link.name}
            </a>
          ))}
          <div className="mt-2 flex flex-col gap-2 border-t border-white/10 pt-3">
            <Link
              href={secondary.href}
              onClick={closeMenu}
              className="rounded-2xl px-4 py-3 text-sm font-medium text-white/85 hover:bg-white/5"
            >
              {secondary.label}
            </Link>
            <Link
              href={cta.href}
              onClick={closeMenu}
              className="flex h-11 items-center justify-center rounded-full bg-white text-sm font-medium text-neutral-950"
            >
              {cta.label}
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
