"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";

/**
 * A destructive submit that asks first, in place, and says what will happen
 * rather than "Are you sure?". Ordinary saving never goes through this: the
 * only things behind a confirmation are the ones that are awkward to undo.
 *
 * It lives inside its own form and submits it, so the action, the hidden
 * fields and the server-side authorization are exactly as they would be
 * without the extra step.
 */
export function ConfirmSubmit({
  label, question, confirmLabel = "Yes, do it", tone = "danger", disabled, pending, compact = false,
}: {
  label: string;
  question: string;
  confirmLabel?: string;
  tone?: "danger" | "secondary";
  disabled?: boolean;
  pending?: boolean;
  compact?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (armed) confirmRef.current?.focus(); }, [armed]);
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setArmed(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [armed]);

  const small = compact
    ? "rounded-md border border-control-border px-2 py-1 text-[12px] text-muted-foreground hover:text-destructive disabled:opacity-50"
    : "";

  if (!armed) {
    return compact ? (
      <button type="button" ref={triggerRef} className={small} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    ) : (
      <Button type="button" tone={tone === "danger" ? "secondary" : tone} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-warning">{question}</span>
      {compact ? (
        <>
          <button type="submit" ref={confirmRef} disabled={pending} className="rounded-md border border-destructive/40 px-2 py-1 text-[12px] text-destructive hover:bg-destructive hover:text-white disabled:opacity-50">
            {pending ? "Working…" : confirmLabel}
          </button>
          <button type="button" onClick={() => { setArmed(false); triggerRef.current?.focus(); }} className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </>
      ) : (
        <>
          <Button type="submit" ref={confirmRef} tone={tone} disabled={pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
          <Button type="button" tone="ghost" onClick={() => { setArmed(false); triggerRef.current?.focus(); }}>
            Cancel
          </Button>
        </>
      )}
    </span>
  );
}
