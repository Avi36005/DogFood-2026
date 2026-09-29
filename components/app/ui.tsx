import Link from "next/link";
import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import { Button as UIButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input as UIInput } from "@/components/ui/input";
import { Textarea as UITextarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty as UIEmpty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import {
  Table as UITable, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/*
  App-screen building blocks. Every element here is either a component from the
  reference project's components/ui (shadcn, new-york) or a pattern lifted from
  its landing sections: the `rounded-xl bg-card border border-border card-shadow`
  card, the mono `// LABEL`, the segmented metric strip, and the white pill
  `bg-foreground text-background` call to action.

  The reference has no application screens of its own — it is a landing page —
  so the judge and organizer consoles are composed from these parts.
*/

// A white card with a hairline edge, as in the dashboard references.
export function Panel({ children, className = "", raised = false }: { children: ReactNode; className?: string; raised?: boolean }) {
  return (
    <div className={cn("rounded-2xl border border-border shadow-[0_1px_2px_rgba(16,24,16,0.04)]", raised ? "bg-secondary" : "bg-card", className)}>
      {children}
    </div>
  );
}

// Dense panels keep a sans title: the reference sets every h1-h6 in the pixel
// face, which suits display headings but not table and form chrome.
export function PanelHeader({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
      <div className="min-w-0">
        <div className="text-[15px] font-semibold tracking-tight text-foreground">{title}</div>
        {sub ? <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

type Tone = "primary" | "pale" | "secondary" | "ghost" | "danger";

// Black is the colour of action. Secondary buttons turn black while pressed.
function toneProps(tone: Tone): { variant: "default" | "outline" | "ghost" | "destructive"; className: string } {
  switch (tone) {
    // The one green button: a positive, primary moment such as creating something.
    case "pale": return { variant: "default", className: "bg-brand text-black hover:bg-brand/85" };
    case "secondary": return { variant: "outline", className: "border-border bg-card text-foreground hover:bg-secondary active:bg-foreground active:text-background active:border-foreground" };
    case "ghost": return { variant: "ghost", className: "text-muted-foreground hover:bg-secondary hover:text-foreground active:bg-foreground active:text-background" };
    case "danger": return { variant: "outline", className: "border-destructive/40 bg-card text-destructive hover:bg-destructive hover:text-white active:bg-foreground active:text-background" };
    default: return { variant: "default", className: "bg-foreground text-background hover:bg-foreground/85 active:bg-black" };
  }
}

export function Button(
  { children, tone = "primary", className = "", ...rest }:
  { children: ReactNode; tone?: Tone } & React.ComponentProps<"button">,
) {
  const t = toneProps(tone);
  // h-11: 44px targets, as the accessibility rules ask.
  return (
    <UIButton variant={t.variant} className={cn("h-11 rounded-full px-5 font-medium transition-colors", t.className, className)} {...rest}>
      {children}
    </UIButton>
  );
}

export function LinkButton(
  { children, href, tone = "primary", className = "" }:
  { children: ReactNode; href: string; tone?: Tone; className?: string },
) {
  const t = toneProps(tone);
  return (
    <UIButton asChild variant={t.variant} className={cn("h-11 rounded-full px-5 font-medium transition-colors", t.className, className)}>
      <Link href={href}>{children}</Link>
    </UIButton>
  );
}

/**
 * A labelled field. The label is tied to the control with `htmlFor`, and the
 * hint or error is tied to it with `aria-describedby`, so a screen reader
 * announces the same three things a sighted person reads. The control keeps
 * its own id when it has one.
 */
export function Field(
  { label, hint, error, children, required }:
  { label: string; hint?: string; error?: string; children: ReactNode; required?: boolean },
) {
  const base = useId();
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  const element = isValidElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>(children)
    ? children : null;
  const controlId = element?.props.id ?? `${base}-control`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="grid gap-2">
      <Label htmlFor={controlId} className="flex items-baseline gap-2">
        {label}
        {required ? <span className="text-xs font-normal text-muted-foreground">required</span> : null}
      </Label>
      {element
        ? cloneElement(element, {
            id: controlId,
            "aria-describedby": describedBy,
            ...(error ? { "aria-invalid": true } : {}),
          })
        : children}
      {hint ? <p id={hintId} className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p id={errorId} className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <UIInput {...props} className={cn("h-11 rounded-xl bg-card", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <UITextarea {...props} className={cn("min-h-24 rounded-xl bg-card", props.className)} />;
}

// A native select, styled as the reference's Input. Native on purpose: these
// forms post FormData and must work before any JavaScript has loaded.
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "fb-select h-11 w-full rounded-xl border bg-card px-3 text-sm shadow-xs outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50",
        props.className,
      )}
    />
  );
}

// Green for done and good, black for what is live right now, amber for in
// progress, red for removed, grey for everything waiting.
const GREEN = "bg-brand-soft text-brand-ink border-transparent";
const BLACK = "bg-foreground text-background border-transparent";
const AMBER = "bg-amber-100 text-amber-900 border-transparent";
const RED = "bg-red-100 text-red-800 border-transparent";
const GREY = "bg-secondary text-muted-foreground border-transparent";
const STATUS: Record<string, string> = {
  draft: GREY, open: GREEN, submissions_closed: AMBER, judging: BLACK,
  results_published: GREEN, archived: GREY, submitted: GREEN, withdrawn: RED,
  pending: GREY, in_progress: AMBER, revoked: RED, published: GREEN,
  computed: GREY, superseded: GREY, disqualified: RED, accepted: GREEN, expired: GREY,
};

// Status is always carried by text, never by colour alone.
export function Status({ value }: { value: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize", STATUS[value] ?? GREY)}>
      {value.replace(/_/g, " ")}
    </Badge>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <Badge variant="secondary" className="rounded-full font-mono text-[11px] font-normal">{children}</Badge>;
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <UIEmpty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {body ? <EmptyDescription>{body}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </UIEmpty>
  );
}

const NOTICE: Record<string, string> = {
  info: "rounded-xl border-border bg-secondary",
  warn: "rounded-xl border-amber-200 bg-amber-50",
  danger: "rounded-xl border-red-200 bg-red-50",
  success: "rounded-xl border-transparent bg-brand-soft",
};

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "danger" | "success"; children: ReactNode }) {
  return (
    <Alert
      variant={tone === "danger" ? "destructive" : "default"}
      role={tone === "danger" ? "alert" : "status"}
      // Failed submissions move focus here, so it has to be focusable without
      // joining the tab order.
      tabIndex={tone === "danger" ? -1 : undefined}
      className={NOTICE[tone]}
    >
      <AlertDescription className="text-foreground">{children}</AlertDescription>
    </Alert>
  );
}

// The reference's mono section label.
export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-sm font-mono text-primary mb-3">{children}</p>;
}

/**
 * `caption` says what the rows are and is read out before them. It is visually
 * hidden because the panel header above already carries the same words.
 */
export function Table({ head, caption, children }: { head: string[]; caption?: string; children: ReactNode }) {
  return (
    <UITable>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <TableHeader>
        <TableRow>
          {head.map((h) => (
            <TableHead key={h} className="text-xs uppercase tracking-wide text-muted-foreground">{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </UITable>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <TableRow className="hover:bg-secondary/60">{children}</TableRow>;
}

export function Cell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <TableCell className={cn("align-top whitespace-normal", className)}>{children}</TableCell>;
}

/**
 * An absolute instant. Always UTC, plus the same moment in the event's own
 * timezone when that is somewhere else, because "18:00 UTC" and "23:30 in the
 * room" are both things a participant needs.
 */
export function When({ iso, tz }: { iso: string | null; tz?: string }) {
  if (!iso) return <span className="text-muted-soft">—</span>;
  let local: string | null = null;
  if (tz && tz !== "UTC") {
    try {
      local = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(iso));
    } catch { local = null; }  // an unknown zone must not break the page
  }
  return (
    <time dateTime={iso} className="font-mono tabular-nums text-xs text-muted-foreground" title={iso}>
      {new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC
      {local ? <span className="text-muted-soft"> · {local} {tz}</span> : null}
    </time>
  );
}

/** How long until an instant, in words. Rendered on the server: not a ticking clock. */
export function Countdown({ iso, prefix = "closes" }: { iso: string | null; prefix?: string }) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  const past = ms < 0;
  const mins = Math.round(Math.abs(ms) / 60000);
  const text = mins < 60 ? `${mins} min`
    : mins < 60 * 48 ? `${Math.round(mins / 60)} h`
    : `${Math.round(mins / (60 * 24))} days`;
  return (
    <span className={past ? "text-muted-foreground" : "text-foreground"}>
      {past ? `${prefix.replace(/s$/, "ed")} ${text} ago` : `${prefix} in ${text}`}
    </span>
  );
}
