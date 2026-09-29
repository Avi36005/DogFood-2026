"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/*
  Scroll-driven motion for the landing sections.

  Built only on what the reference project already uses — CSS transitions,
  tw-animate-css and IntersectionObserver — so no animation library is added.
  Everything animates transform and opacity, and anyone who has asked their
  system for reduced motion gets the final state immediately.
*/

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True once the element has scrolled into view. Fires once, then disconnects. */
export function useInView<T extends Element>(threshold = 0.18) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) { setInView(true); return; }
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); io.disconnect(); } },
      { threshold, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, inView] as const;
}

type From = "up" | "down" | "left" | "right" | "scale" | "blur";
const HIDDEN: Record<From, string> = {
  up: "opacity-0 translate-y-8",
  down: "opacity-0 -translate-y-8",
  left: "opacity-0 -translate-x-10",
  right: "opacity-0 translate-x-10",
  scale: "opacity-0 scale-90",
  blur: "opacity-0 blur-[6px] translate-y-3",
};

/**
 * Fades an element in from a direction. Pass `show` to drive a whole group from
 * one observer (and stagger with `delay`); otherwise it observes itself.
 */
export function Reveal({
  children, from = "up", delay = 0, duration = 750, show, className = "", style,
}: {
  children: ReactNode; from?: From; delay?: number; duration?: number;
  show?: boolean; className?: string; style?: CSSProperties;
}) {
  const [ref, own] = useInView<HTMLDivElement>();
  const visible = show ?? own;
  return (
    <div
      ref={show === undefined ? ref : undefined}
      className={`transition-[opacity,transform,filter] ease-[cubic-bezier(0.22,1,0.36,1)] ${
        visible ? "opacity-100 translate-x-0 translate-y-0 scale-100 blur-0" : HIDDEN[from]
      } ${className}`}
      style={{ transitionDuration: `${duration}ms`, transitionDelay: `${delay}ms`, ...style }}
    >
      {children}
    </div>
  );
}

/** Counts from 0 to `value` once visible (ease-out cubic). */
export function CountUp({
  value, duration = 1600, suffix = "", show, className = "",
}: { value: number; duration?: number; suffix?: string; show?: boolean; className?: string }) {
  const [ref, own] = useInView<HTMLSpanElement>();
  const visible = show ?? own;
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!visible) return;
    if (prefersReducedMotion()) { setN(value); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setN(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, value, duration]);
  return <span ref={show === undefined ? ref : undefined} className={`tabular-nums ${className}`}>{n.toLocaleString()}{suffix}</span>;
}

/**
 * Types a block of text out character by character once visible, with a
 * blinking caret while it runs. Renders the full text for reduced motion.
 */
export function TypeText({
  text, speed = 22, delay = 0, show, className = "", caret = true,
}: { text: string; speed?: number; delay?: number; show?: boolean; className?: string; caret?: boolean }) {
  const [ref, own] = useInView<HTMLSpanElement>();
  const visible = show ?? own;
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!visible) return;
    if (prefersReducedMotion()) { setCount(text.length); return; }
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      i += 1;
      setCount(i);
      if (i < text.length) timer = setTimeout(step, speed);
    };
    timer = setTimeout(step, delay);
    return () => clearTimeout(timer);
  }, [visible, text, speed, delay]);
  const done = count >= text.length;
  return (
    <span ref={show === undefined ? ref : undefined} className={className}>
      {text.slice(0, count)}
      {caret && !done && visible ? <span className="fb-caret inline-block w-[0.55em] -mb-px h-[1em] translate-y-[2px] bg-primary/80 align-baseline" aria-hidden /> : null}
      {/* Screen readers get the whole text at once rather than a stream of letters. */}
      <span className="sr-only">{text.slice(count)}</span>
    </span>
  );
}

/** Steps a highlight index through `length` items on an interval, once visible. */
export function useCycle(length: number, every = 1800, show = true) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!show || length < 2 || prefersReducedMotion()) return;
    const t = setInterval(() => setI((x) => (x + 1) % length), every);
    return () => clearInterval(t);
  }, [length, every, show]);
  return i;
}
