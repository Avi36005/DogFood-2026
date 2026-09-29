"use client";

import { useEffect, useState } from "react";
import { saveProjectAction } from "@/lib/actions/participant.ts";
import { Button, Countdown, Field, Input, Notice, Panel, PanelHeader, Select, Textarea, When } from "./ui";
import { useFormAction, useUnsavedWarning } from "./form";

type Project = {
  id: string; version: number; status: string;
  name: string; tagline: string; description: string;
  track_id: string | null; repo_url: string; live_url: string; demo_video_url: string;
};

export function SubmissionForm({
  slug, project, tracks, questions, answers, tags, readOnly, canSubmit, problems = [], deadline, timezone,
}: {
  slug: string;
  project: Project;
  tracks: { id: string; name: string }[];
  questions: {
    id: string; prompt: string; kind: string; required: boolean;
    helpText: string; isPublic: boolean; options: string[];
  }[];
  answers: Record<string, string>;
  tags: string[];
  readOnly: boolean;
  canSubmit: boolean;
  problems?: { field: string; message: string }[];
  deadline?: string | null;
  timezone?: string;
}) {
  const [state, action, pending, keep] = useFormAction(saveProjectAction);
  useUnsavedWarning(keep.ref, state);

  // "Saved at" is the moment the server confirmed, not the moment of clicking.
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => { if (state.ok) setSavedAt(new Date().toLocaleTimeString()); }, [state]);

  const problemFor = (field: string) => problems.find((p) => p.field === field)?.message;

  return (
    <form action={action} {...keep} className="space-y-6">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="version" value={project.version} />

      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}

      <Panel>
        <PanelHeader title="The basics" />
        <div className="space-y-5 px-5 py-5">
          <Field label="Project name" required error={problemFor("name")}>
            <Input name="name" defaultValue={project.name} maxLength={120} disabled={readOnly} required />
          </Field>
          <Field label="Tagline" hint="One line. This is what the gallery shows." required error={problemFor("tagline")}>
            <Input name="tagline" defaultValue={project.tagline} maxLength={200} disabled={readOnly} required />
          </Field>
          <Field label="Description" hint="What it does, what you cut, what is not finished." required error={problemFor("description")}>
            <Textarea name="description" defaultValue={project.description} rows={10} disabled={readOnly} required />
          </Field>
          {tracks.length ? (
            <Field label="Track" required error={problemFor("track_id")}>
              <Select name="track_id" defaultValue={project.track_id ?? ""} disabled={readOnly} required>
                <option value="">Choose a track…</option>
                {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="Technology tags" hint="Comma separated, up to 12.">
            <Input name="tags" defaultValue={tags.join(", ")} disabled={readOnly} placeholder="typescript, postgres, docker" />
          </Field>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Links" sub="Optional, but judges will look for them. Nothing here is fetched by the server." />
        <div className="space-y-5 px-5 py-5">
          <Field label="Repository URL">
            <Input name="repo_url" type="url" defaultValue={project.repo_url} disabled={readOnly} placeholder="https://" />
          </Field>
          <Field label="Live URL">
            <Input name="live_url" type="url" defaultValue={project.live_url} disabled={readOnly} placeholder="https://" />
          </Field>
          <Field label="Demo video URL">
            <Input name="demo_video_url" type="url" defaultValue={project.demo_video_url} disabled={readOnly} placeholder="https://" />
          </Field>
        </div>
      </Panel>

      {questions.length ? (
        <Panel>
          <PanelHeader title="Organizer questions" />
          <div className="space-y-5 px-5 py-5">
            {questions.map((q) => {
              const hint = [q.helpText, q.isPublic ? "Shown on the public project page." : "Seen by organizers and your assigned judges."]
                .filter(Boolean).join(" ");
              const chosen = (answers[q.id] ?? "").split("\n").map((v) => v.trim()).filter(Boolean);

              if (q.kind === "multi_select") {
                return (
                  <fieldset key={q.id} className="grid gap-2" aria-describedby={`${q.id}-hint`}>
                    <legend className="flex items-baseline gap-2 text-sm font-medium">
                      {q.prompt}
                      {q.required ? <span className="text-xs font-normal text-muted-foreground">required</span> : null}
                    </legend>
                    <div className="flex flex-col gap-2">
                      {q.options.map((o) => (
                        <label key={o} className="flex items-center gap-2 text-[14px] text-foreground">
                          <input
                            type="checkbox" name={`q:${q.id}`} value={o}
                            defaultChecked={chosen.includes(o)} disabled={readOnly}
                            className="h-4 w-4 accent-primary"
                          />
                          {o}
                        </label>
                      ))}
                    </div>
                    <p id={`${q.id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
                  </fieldset>
                );
              }

              return (
                <Field key={q.id} label={q.prompt} hint={hint || undefined} required={q.required} error={problemFor(`q:${q.id}`)}>
                  {q.kind === "long_text" ? (
                    <Textarea name={`q:${q.id}`} defaultValue={answers[q.id] ?? ""} rows={5} disabled={readOnly} required={q.required} />
                  ) : q.kind === "single_select" ? (
                    <Select name={`q:${q.id}`} defaultValue={chosen[0] ?? ""} disabled={readOnly} required={q.required}>
                      <option value="">Choose one…</option>
                      {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <Input
                      name={`q:${q.id}`} type={q.kind === "url" ? "url" : "text"}
                      defaultValue={answers[q.id] ?? ""} disabled={readOnly} required={q.required}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </Panel>
      ) : null}

      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" name="intent" value="save" tone="secondary" disabled={pending}>
            {pending ? "Saving…" : "Save draft"}
          </Button>
          <Button type="submit" name="intent" value="submit" disabled={pending}>
            {project.status === "submitted" ? "Save and resubmit" : "Submit project"}
          </Button>
          {!canSubmit ? (
            <span className="text-[12px] text-muted-foreground">Fill the required fields to enable submission.</span>
          ) : null}
          {savedAt && !pending ? (
            <span className="text-[12px] text-success" aria-live="polite">Saved at {savedAt}</span>
          ) : null}
          {deadline ? (
            <span className="text-[12px] text-muted-foreground">
              Deadline <When iso={deadline} tz={timezone} /> · <Countdown iso={deadline} />
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
