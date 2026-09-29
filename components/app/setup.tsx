"use client";

import { useState } from "react";
import {
  addPrizeAction, addQuestionAction, addTrackAction,
  removePrizeAction, removeQuestionAction, removeTrackAction, updateEventAction,
} from "@/lib/actions/events.ts";
import { Button, Field, Input, Notice, Panel, PanelHeader, Select, Textarea } from "./ui";
import { ConfirmSubmit } from "./confirm";
import { useFormAction, useUnsavedWarning } from "./form";

type Track = { id: string; name: string; description: string };
type Prize = { id: string; name: string; amount_text: string; description: string; track_id: string | null };
type Question = {
  id: string; prompt: string; help_text: string; kind: string;
  required: number; is_public: number; options_json: string; answered: number;
};

const KIND_LABEL: Record<string, string> = {
  short_text: "Short text",
  long_text: "Long text",
  url: "URL",
  single_select: "Choose one",
  multi_select: "Choose several",
};

/** datetime-local wants "YYYY-MM-DDTHH:mm"; the database holds a UTC instant. */
const local = (iso: string | null) => (iso ? iso.slice(0, 16) : "");

export function EventSettings({ slug, event, timezones }: {
  slug: string;
  event: {
    name: string; tagline: string; description: string; timezone: string; version: number;
    submissions_open_at: string | null; submissions_close_at: string | null;
    judging_open_at: string | null; judging_close_at: string | null;
    max_team_size: number; reviews_per_project: number;
  };
  timezones: string[];
}) {
  const [state, action, pending, keep] = useFormAction(updateEventAction);
  useUnsavedWarning(keep.ref, state);

  return (
    <Panel>
      <PanelHeader
        title="Event details"
        sub="Times are stored in UTC and shown to everyone in this event's timezone as well."
      />
      <form action={action} {...keep} className="space-y-5 px-6 py-6">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="version" value={event.version} />
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}

        <Field label="Name" required>
          <Input name="name" defaultValue={event.name} maxLength={120} required />
        </Field>
        <Field label="Tagline" hint="One line, shown under the name on the public page.">
          <Input name="tagline" defaultValue={event.tagline} maxLength={200} />
        </Field>
        <Field label="Description">
          <Textarea name="description" defaultValue={event.description} rows={5} />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Display timezone" hint="Deadlines are shown in this zone as well as UTC.">
            <Select name="timezone" defaultValue={event.timezone}>
              {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
          </Field>
          <Field label="Maximum team size">
            <Input type="number" name="max_team_size" min={1} max={50} defaultValue={event.max_team_size} className="font-mono tabular-nums" />
          </Field>
          <Field label="Submissions open (UTC)">
            <Input type="datetime-local" name="submissions_open_at" defaultValue={local(event.submissions_open_at)} />
          </Field>
          <Field label="Submissions close (UTC)" hint="The server refuses participant writes from this instant.">
            <Input type="datetime-local" name="submissions_close_at" defaultValue={local(event.submissions_close_at)} />
          </Field>
          <Field label="Judging opens (UTC)">
            <Input type="datetime-local" name="judging_open_at" defaultValue={local(event.judging_open_at)} />
          </Field>
          <Field label="Judging closes (UTC)">
            <Input type="datetime-local" name="judging_close_at" defaultValue={local(event.judging_close_at)} />
          </Field>
          <Field label="Reviews per project" hint="The assignment target, and the coverage warning threshold.">
            <Input type="number" name="reviews_per_project" min={1} max={20} defaultValue={event.reviews_per_project} className="font-mono tabular-nums" />
          </Field>
        </div>

        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button>
      </form>
    </Panel>
  );
}

export function Tracks({ slug, tracks }: { slug: string; tracks: (Track & { projects: number })[] }) {
  const [state, action, pending, keep] = useFormAction(addTrackAction);
  const [removeState, remove] = useFormAction(removeTrackAction);

  return (
    <Panel>
      <PanelHeader title="Tracks" sub="Optional groupings. A judge can be restricted to one track." />
      {tracks.length ? (
        <ul className="divide-y divide-border/60">
          {tracks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <div className="text-[14px] text-foreground">{t.name}</div>
                {t.description ? <div className="text-[12px] text-muted-foreground">{t.description}</div> : null}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[12px] text-muted-foreground">{t.projects} project(s)</span>
                <form action={remove}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="trackId" value={t.id} />
                  <ConfirmSubmit
                    compact
                    label="Remove"
                    question={`Remove the ${t.name} track?`}
                    confirmLabel="Remove it"
                    disabled={t.projects > 0}
                  />
                </form>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-6 py-4 text-[13px] text-muted-soft">No tracks yet. One track is fine; so is none.</p>
      )}

      <form action={action} {...keep} className="space-y-4 border-t border-border px-6 py-5">
        <input type="hidden" name="slug" value={slug} />
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {removeState.error ? <Notice tone="danger">{removeState.error}</Notice> : null}
        {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Track name"><Input name="name" maxLength={80} placeholder="Developer tooling" /></Field>
          <Field label="Description" hint="Optional."><Input name="description" maxLength={200} /></Field>
        </div>
        <Button type="submit" tone="secondary" disabled={pending}>{pending ? "Adding…" : "Add track"}</Button>
      </form>
    </Panel>
  );
}

export function Prizes({ slug, prizes, tracks }: { slug: string; prizes: Prize[]; tracks: Track[] }) {
  const [state, action, pending, keep] = useFormAction(addPrizeAction);
  const [removeState, remove] = useFormAction(removePrizeAction);
  const trackName = (id: string | null) => tracks.find((t) => t.id === id)?.name;

  return (
    <Panel>
      <PanelHeader title="Prizes" sub="Listed on the public event page. Nothing here affects scoring." />
      {prizes.length ? (
        <ul className="divide-y divide-border/60">
          {prizes.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <div className="text-[14px] text-foreground">
                  {p.name}
                  {p.amount_text ? <span className="ml-2 font-mono text-[12px] text-brand-ink">{p.amount_text}</span> : null}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {trackName(p.track_id) ? `${trackName(p.track_id)} only` : "All tracks"}
                  {p.description ? ` · ${p.description}` : ""}
                </div>
              </div>
              <form action={remove}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="prizeId" value={p.id} />
                <ConfirmSubmit compact label="Remove" question={`Remove the ${p.name} prize?`} confirmLabel="Remove it" />
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-6 py-4 text-[13px] text-muted-soft">No prizes listed.</p>
      )}

      <form action={action} {...keep} className="space-y-4 border-t border-border px-6 py-5">
        <input type="hidden" name="slug" value={slug} />
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {removeState.error ? <Notice tone="danger">{removeState.error}</Notice> : null}
        {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Prize"><Input name="name" maxLength={80} placeholder="Best use of open data" /></Field>
          <Field label="Amount or reward" hint="Free text."><Input name="amount_text" maxLength={80} placeholder="$500" /></Field>
          <Field label="Track">
            <Select name="trackId" defaultValue="">
              <option value="">All tracks</option>
              {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Description" hint="Optional."><Input name="description" maxLength={200} /></Field>
        <Button type="submit" tone="secondary" disabled={pending}>{pending ? "Adding…" : "Add prize"}</Button>
      </form>
    </Panel>
  );
}

export function Questions({ slug, questions }: { slug: string; questions: Question[] }) {
  const [state, action, pending, keep] = useFormAction(addQuestionAction);
  const [removeState, remove] = useFormAction(removeQuestionAction);
  const [kind, setKind] = useState("short_text");
  const needsOptions = kind === "single_select" || kind === "multi_select";

  return (
    <Panel>
      <PanelHeader
        title="Submission questions"
        sub="Your own fields on every submission form. Answers stay private unless you mark a question public."
      />
      {questions.length ? (
        <ul className="divide-y divide-border/60">
          {questions.map((q) => {
            let options: string[] = [];
            try { const parsed: unknown = JSON.parse(q.options_json); if (Array.isArray(parsed)) options = parsed.map(String); }
            catch { options = []; }
            return (
              <li key={q.id} className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
                <div className="min-w-0">
                  <div className="text-[14px] text-foreground">{q.prompt}</div>
                  {q.help_text ? <div className="text-[12px] text-muted-foreground">{q.help_text}</div> : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">{KIND_LABEL[q.kind] ?? q.kind}</span>
                    {q.required ? <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">required</span> : null}
                    <span className="text-[11px] text-muted-foreground">{q.is_public ? "Public on the project page" : "Private to the team, organizers and judges"}</span>
                    {options.length ? <span className="text-[11px] text-muted-soft">{options.join(" · ")}</span> : null}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[12px] text-muted-foreground">{q.answered} answered</span>
                  <form action={remove}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="questionId" value={q.id} />
                    <ConfirmSubmit
                      compact
                      label="Remove"
                      question={q.answered > 0 ? "Teams have answered this." : "Remove this question?"}
                      confirmLabel="Remove it"
                      disabled={q.answered > 0}
                    />
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-6 py-4 text-[13px] text-muted-soft">
          No extra questions. Every submission still has a name, tagline, description, track, links, tags and media.
        </p>
      )}

      <form action={action} {...keep} className="space-y-4 border-t border-border px-6 py-5">
        <input type="hidden" name="slug" value={slug} />
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {removeState.error ? <Notice tone="danger">{removeState.error}</Notice> : null}
        {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}

        <Field label="Question" required>
          <Input name="prompt" maxLength={200} placeholder="What did you cut to make the deadline?" />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Select name="kind" value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Help text" hint="Shown under the field."><Input name="help_text" maxLength={200} /></Field>
        </div>
        {needsOptions ? (
          <Field label="Options" hint="One per line, at least two." required>
            <Textarea name="options" rows={4} placeholder={"Yes\nNo\nPartly"} />
          </Field>
        ) : null}
        <div className="flex flex-wrap gap-5">
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <input type="checkbox" name="required" className="h-4 w-4 accent-primary" />
            Teams must answer it before submitting
          </label>
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <input type="checkbox" name="is_public" className="h-4 w-4 accent-primary" />
            Show the answer on the public project page
          </label>
        </div>
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? "Adding…" : "Add question"}
        </Button>
      </form>
    </Panel>
  );
}

export function SetupChecklist({ items }: { items: { label: string; done: boolean; detail: string; href: string }[] }) {
  const done = items.filter((i) => i.done).length;
  return (
    <Panel>
      <PanelHeader
        title="Setup"
        sub={`${done} of ${items.length} done. Every line is read from the event itself.`}
      />
      <ul className="divide-y divide-border/60">
        {items.map((i) => (
          <li key={i.label} className="flex items-start gap-3 px-6 py-3">
            <span
              aria-hidden
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                i.done ? "border-transparent bg-brand-soft text-brand-ink" : "border-control-border text-muted-soft"
              }`}
            >
              {i.done ? "✓" : ""}
            </span>
            <span className="min-w-0 flex-1">
              <a href={i.href} className="text-[14px] text-foreground hover:underline">
                {i.label}
                <span className="sr-only">{i.done ? " — done" : " — still to do"}</span>
              </a>
              <span className="block text-[12px] text-muted-foreground">{i.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
