"use client";

import { useActionState, useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import { unstable_rethrow } from "next/navigation";
import { Button, Notice } from "./ui";
import type { FormState } from "@/lib/actions/auth.ts";

export function Submit({ children, tone = "primary", className = "" }: { children: React.ReactNode; tone?: "primary" | "secondary" | "danger"; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" tone={tone} disabled={pending} className={className}>
      {pending ? "Working…" : children}
    </Button>
  );
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Snapshot = Map<string, string | boolean | string[]>;

const SKIPPED = new Set(["file", "password", "hidden", "submit", "button", "reset", "image"]);

/** Stable key per field. Radios and checkboxes are keyed by value, repeated names by position. */
function fieldKeys(form: HTMLFormElement): [string, Field][] {
  const seen = new Map<string, number>();
  const out: [string, Field][] = [];
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) continue;
    if (!el.name || (el instanceof HTMLInputElement && SKIPPED.has(el.type))) continue;
    if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
      out.push([`${el.name}\u0000${el.value}`, el]);
      continue;
    }
    const n = seen.get(el.name) ?? 0;
    seen.set(el.name, n + 1);
    out.push([`${el.name}#${n}`, el]);
  }
  return out;
}

function capture(form: HTMLFormElement): Snapshot {
  const snap: Snapshot = new Map();
  for (const [key, el] of fieldKeys(form)) {
    if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) snap.set(key, el.checked);
    else if (el instanceof HTMLSelectElement && el.multiple) snap.set(key, Array.from(el.selectedOptions, (o) => o.value));
    else snap.set(key, el.value);
  }
  return snap;
}

function restore(form: HTMLFormElement, snap: Snapshot) {
  for (const [key, el] of fieldKeys(form)) {
    if (!snap.has(key)) continue;
    const v = snap.get(key)!;
    if (typeof v === "boolean") (el as HTMLInputElement).checked = v;
    else if (Array.isArray(v)) for (const o of Array.from((el as HTMLSelectElement).options)) o.selected = v.includes(o.value);
    else el.value = v;
  }
}

export const NETWORK_ERROR =
  "The server could not be reached, so nothing was saved. What you entered is still here; try again.";

/**
 * useActionState, plus the guarantee that a failed submission never costs the
 * person what they typed.
 *
 * React 19 resets every uncontrolled field once a form action finishes, even
 * when the action only returned a validation error. So the fields are
 * snapshotted on submit and put back, after that reset, whenever the result is
 * an error. A successful submission still clears the form as before.
 *
 * A dropped connection makes the action throw, which would otherwise replace
 * the page with an error screen. It becomes an ordinary error result instead.
 * Next's own redirect and not-found signals are rethrown untouched.
 *
 * Passwords and file inputs are deliberately not restored.
 *
 * Spread the fourth value onto the <form>: `<form action={dispatch} {...keep}>`.
 */
export function useFormAction<S extends FormState>(
  action: (prev: S, fd: FormData) => Promise<S>,
  initial: S = {} as S,
) {
  // The casts are the price of wrapping useActionState generically: S is a
  // plain result object, never a promise, so S and Awaited<S> are the same type.
  const [current, dispatch, pending] = useActionState<S, FormData>(async (prev, fd): Promise<S> => {
    try {
      return await action(prev as S, fd);
    } catch (err) {
      unstable_rethrow(err);
      return { error: NETWORK_ERROR } as S;
    }
  }, initial as Awaited<S>);
  const state = current as S;

  const ref = useRef<HTMLFormElement>(null);
  const snapshot = useRef<Snapshot | null>(null);

  // Runs after React's form reset, which happens in the same commit.
  useLayoutEffect(() => {
    const form = ref.current;
    const snap = snapshot.current;
    snapshot.current = null;
    if (!form) return;
    if (state.error && snap) restore(form, snap);
    // Send focus to the message, so the reason a submission failed is the next
    // thing announced rather than something to go hunting for.
    if (state.error) form.querySelector<HTMLElement>('[role="alert"]')?.focus();
  }, [state]);

  const onSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    snapshot.current = capture(e.currentTarget);
  }, []);

  return [state, dispatch, pending, { ref, onSubmit }] as const;
}

/**
 * Warns before a half-finished form is abandoned: a reload or a close goes
 * through the browser's own prompt, and an in-app link asks first. Any
 * successful save clears the warning, so ordinary work is never interrupted.
 */
export function useUnsavedWarning(ref: RefObject<HTMLFormElement | null>, state: FormState) {
  const dirty = useRef(false);

  useEffect(() => { if (state.ok) dirty.current = false; }, [state]);

  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    const mark = () => { dirty.current = true; };
    form.addEventListener("input", mark);
    form.addEventListener("change", mark);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (!dirty.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm("You have unsaved changes on this page. Leave without saving?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      form.removeEventListener("input", mark);
      form.removeEventListener("change", mark);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [ref]);
}

export function ActionForm({
  action, children, submitLabel, className = "",
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
}) {
  const [state, formAction, , keep] = useFormAction(action);
  return (
    <form action={formAction} {...keep} className={className}>
      {state.error ? <div className="mb-4"><Notice tone="danger">{state.error}</Notice></div> : null}
      {state.ok ? <div className="mb-4"><Notice tone="success">{state.ok}</Notice></div> : null}
      {children}
      <div className="mt-6"><Submit>{submitLabel}</Submit></div>
    </form>
  );
}
