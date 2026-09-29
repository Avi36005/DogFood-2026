"use client";

import { useEffect, useState } from "react";
import { saveReviewAction } from "@/lib/actions/judging.ts";
import { Button, Notice, Panel, PanelHeader, Textarea } from "./ui";
import { useFormAction, useUnsavedWarning } from "./form";

type Criterion = { id: string; name: string; description: string; weight: number; min: number; max: number };

/**
 * Scoring is radio buttons rather than a dropdown or a slider: one tap per
 * criterion, the whole scale visible, and it works from a keyboard. Thirty
 * projects in an afternoon is a UX problem before it is anything else.
 */
export function ReviewForm({
  slug, assignmentId, rubricName, criteria, scores, overall, readOnly,
  nextAssignmentId = null, nextProjectName = null,
}: {
  slug: string; assignmentId: string; rubricName: string;
  criteria: Criterion[];
  scores: Record<string, { score: number; comment: string }>;
  overall: string;
  readOnly: boolean;
  nextAssignmentId?: string | null;
  nextProjectName?: string | null;
}) {
  const [state, action, pending, keep] = useFormAction(saveReviewAction);
  useUnsavedWarning(keep.ref, state);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => { if (state.ok) setSavedAt(new Date().toLocaleTimeString()); }, [state]);
  const [live, setLive] = useState<Record<string, number>>(
    Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.score])),
  );

  const totalWeight = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  const scored = criteria.filter((c) => live[c.id] !== undefined);
  const running = scored.length
    ? scored.reduce((a, c) => a + c.weight * live[c.id], 0) / scored.reduce((a, c) => a + c.weight, 0)
    : null;

  return (
    <form action={action} {...keep}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      {/* Set by "Submit and next"; empty for an ordinary submit. */}
      <input type="hidden" name="thenNext" defaultValue="" />

      {state.error ? <div className="mb-4"><Notice tone="danger">{state.error}</Notice></div> : null}
      {state.ok ? <div className="mb-4"><Notice tone="success">{state.ok}</Notice></div> : null}

      <Panel>
        <PanelHeader
          title={rubricName}
          sub={`${criteria.length} criteria, weighted`}
          action={
            running !== null ? (
              <div className="text-right">
                <div className="font-mono tabular-nums text-[20px] leading-none text-primary">{running.toFixed(2)}</div>
                <div className="text-[11px] text-muted-foreground">running</div>
              </div>
            ) : null
          }
        />

        <div className="divide-y divide-border/60">
          {criteria.map((c) => {
            const steps = Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i);
            return (
              <fieldset key={c.id} className="px-5 py-5">
                <legend className="flex w-full items-baseline justify-between gap-3">
                  <span className="text-[14px] font-medium text-foreground">{c.name}</span>
                  <span className="font-mono tabular-nums text-[11px] text-muted-foreground">
                    {Math.round((c.weight / totalWeight) * 100)}%
                  </span>
                </legend>
                {c.description ? <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{c.description}</p> : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  {steps.map((n) => {
                    const active = live[c.id] === n;
                    return (
                      <label
                        key={n}
                        // The input itself is screen-reader-only, so the label
                        // carries the focus ring: keyboard scoring has to be
                        // visible, not just possible.
                        className={`inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-[10px] border text-[14px] transition-colors
                          has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:border-ring ${
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-control-border text-muted-foreground hover:border-primary hover:text-foreground"
                        } ${readOnly ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        <input
                          type="radio" name={`score:${c.id}`} value={n}
                          defaultChecked={scores[c.id]?.score === n}
                          disabled={readOnly}
                          onChange={() => setLive((s) => ({ ...s, [c.id]: n }))}
                          className="sr-only"
                        />
                        <span className="font-mono tabular-nums">{n}</span>
                        <span className="sr-only">{c.name}: {n} out of {c.max}</span>
                      </label>
                    );
                  })}
                </div>

                <Textarea
                  name={`note:${c.id}`} rows={2} disabled={readOnly}
                  defaultValue={scores[c.id]?.comment ?? ""}
                  placeholder="Optional note for the organizer"
                  className="mt-3 text-[13px]"
                />
              </fieldset>
            );
          })}
        </div>

        <div className="border-t border-border px-5 py-5">
          <label className="mb-1.5 block text-[13px] font-medium text-foreground">
            Feedback for the team
          </label>
          <p className="mb-2 text-[12px] text-muted-foreground">
            Shared with the team once results are published, without your name attached.
          </p>
          <Textarea name="overall" rows={5} defaultValue={overall} disabled={readOnly} />
        </div>
      </Panel>

      {!readOnly ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <Button type="submit" name="intent" value="save" tone="secondary" disabled={pending}>
            {pending ? "Saving…" : "Save draft"}
          </Button>
          <Button type="submit" name="intent" value="submit" disabled={pending || scored.length < criteria.length}>
            Submit review
          </Button>
          {nextAssignmentId ? (
            <Button
              type="submit" name="intent" value="submit" tone="secondary"
              disabled={pending || scored.length < criteria.length}
              onClick={(e) => {
                const form = e.currentTarget.form;
                const field = form?.elements.namedItem("thenNext") as HTMLInputElement | null;
                if (field) field.value = nextAssignmentId;
              }}
            >
              Submit and next{nextProjectName ? `: ${nextProjectName.slice(0, 24)}` : ""}
            </Button>
          ) : null}
          {scored.length < criteria.length ? (
            <span className="self-center text-[12px] text-muted-foreground">
              {criteria.length - scored.length} criterion left to score
            </span>
          ) : null}
          {savedAt && !pending ? (
            <span className="self-center text-[12px] text-success" aria-live="polite">Draft saved at {savedAt}</span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
