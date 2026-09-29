"use client";

import { Button, Cell, Notice, Panel, PanelHeader, Row, Table, When } from "./ui";
import { ConfirmSubmit } from "./confirm";
import { CopyLink } from "./copy";
import { useFormAction } from "./form";
import {
  setStatusAction, generateAssignmentsAction, inviteJudgeAction, revokeInvitationAction,
  removeJudgeAction, publishRubricAction, computeResultsAction, setEligibilityAction,
} from "@/lib/actions/judging.ts";
import { useState } from "react";

const NEXT: Record<string, { to: string; label: string; note: string }[]> = {
  draft: [{ to: "open", label: "Open the event", note: "Teams can form and submit." }],
  open: [{ to: "submissions_closed", label: "Close submissions", note: "No further edits by participants." }],
  submissions_closed: [
    { to: "judging", label: "Start judging", note: "Judges can score their queues." },
    { to: "open", label: "Reopen submissions", note: "Undo the close." },
  ],
  judging: [{ to: "submissions_closed", label: "Pause judging", note: "Judges lose the ability to submit." }],
  results_published: [{ to: "judging", label: "Return to judging", note: "Unpublishes the standings." }],
  archived: [],
};

export function StatusControl({ slug, current }: { slug: string; current: string }) {
  const [state, action, pending] = useFormAction(setStatusAction);
  const options = NEXT[current] ?? [];
  return (
    <Panel>
      <PanelHeader title="Event phase" sub="Transitions are validated on the server; illegal jumps are refused." />
      <div className="px-5 py-5">
        {state.error ? <div className="mb-4"><Notice tone="danger">{state.error}</Notice></div> : null}
        {state.ok ? <div className="mb-4"><Notice tone="success">{state.ok}</Notice></div> : null}
        {options.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No further transitions are available from this phase.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {options.map((o) => (
              <form key={o.to} action={action}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="status" value={o.to} />
                <Button type="submit" tone="secondary" disabled={pending}>{o.label}</Button>
                <p className="mt-1 max-w-[220px] text-[11px] text-muted-soft">{o.note}</p>
              </form>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Judge invitations. The organizer creates a scoped link and passes it on
 * themselves; Forgeboard sends no email. The track restriction lives on the
 * invitation, so accepting it cannot widen the grant.
 */
export function InviteJudge({ slug, tracks }: { slug: string; tracks: { id: string; name: string }[] }) {
  const [state, action, pending, keep] = useFormAction(inviteJudgeAction);
  return (
    <form action={action} {...keep} className="px-5 py-5">
      {state.error ? <div className="mb-4"><Notice tone="danger">{state.error}</Notice></div> : null}
      {state.ok ? <div className="mb-4"><Notice tone="success">{state.ok}</Notice></div> : null}
      <input type="hidden" name="slug" value={slug} />
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          name="email" type="email" placeholder="judge@example.org (optional)" aria-label="Restrict the invitation to one email address"
          className="min-h-[44px] flex-1 rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-soft focus:border-primary focus:outline-none"
        />
        <select
          name="trackId" aria-label="Track restriction" defaultValue=""
          className="min-h-[44px] rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground focus:border-primary focus:outline-none"
        >
          <option value="">All tracks</option>
          {tracks.map((t) => <option key={t.id} value={t.id}>{t.name} only</option>)}
        </select>
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create invitation"}</Button>
      </div>
      <p className="mt-2 text-[12px] text-muted-soft">
        Valid for seven days and usable once. Naming an address means only the account with that address
        can accept it; leaving it blank lets whoever holds the link accept it.
      </p>
      {state.link ? (
        <div className="mt-4">
          <CopyLink path={state.link} label="Judge invitation link" />
        </div>
      ) : null}
    </form>
  );
}

const INVITE_TONE: Record<string, string> = {
  pending: "text-foreground", accepted: "text-success",
  revoked: "text-destructive", expired: "text-muted-foreground",
};

export function Invitations({ slug, invitations }: {
  slug: string;
  invitations: {
    id: string; state: string; trackName: string | null; addressedTo: string;
    createdAt: string; expiresAt: string; acceptedName: string | null;
  }[];
}) {
  const [state, revoke] = useFormAction(revokeInvitationAction);
  if (invitations.length === 0) {
    return <p className="px-5 py-4 text-[13px] text-muted-soft">No invitations yet.</p>;
  }
  return (
    <>
      {state.error ? <div className="px-5 pt-4"><Notice tone="danger">{state.error}</Notice></div> : null}
      <Table head={["Invitation", "Scope", "State", "Expires", ""]} caption="Judge invitations for this event">
        {invitations.map((i) => (
          <Row key={i.id}>
            <Cell>
              <div className="text-foreground">{i.addressedTo || "Anyone with the link"}</div>
              <div className="font-mono text-[11px] text-muted-foreground">created <When iso={i.createdAt} /></div>
            </Cell>
            <Cell className={i.trackName ? "text-warning" : "text-muted-foreground"}>
              {i.trackName ? `${i.trackName} only` : "All tracks"}
            </Cell>
            <Cell className={INVITE_TONE[i.state] ?? ""}>
              {i.state === "accepted" && i.acceptedName ? `accepted by ${i.acceptedName}` : i.state}
            </Cell>
            <Cell><When iso={i.expiresAt} /></Cell>
            <Cell>
              {i.state === "pending" ? (
                <form action={revoke}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="invitationId" value={i.id} />
                  <ConfirmSubmit
                    compact label="Revoke"
                    question="Revoke this invitation? The link stops working."
                    confirmLabel="Revoke it"
                  />
                </form>
              ) : null}
            </Cell>
          </Row>
        ))}
      </Table>
    </>
  );
}

/** Removing a judge: their submitted reviews stay, their unfinished work is released. */
export function RemoveJudge({ slug, userId, name, submitted }: {
  slug: string; userId: string; name: string; submitted: number;
}) {
  const [state, action, pending, keep] = useFormAction(removeJudgeAction);
  return (
    <form action={action} {...keep}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="userId" value={userId} />
      <ConfirmSubmit
        compact
        label="Remove"
        question={submitted > 0
          ? `Remove ${name}? Their ${submitted} submitted review(s) are kept.`
          : `Remove ${name} from the panel?`}
        confirmLabel="Remove"
        pending={pending}
      />
      {state.error ? <span className="ml-2 text-[12px] text-destructive">{state.error}</span> : null}
    </form>
  );
}

/**
 * Assignments, previewed before they exist. The preview is a dry run of the
 * same planner; committing runs it again on the server, so what comes back
 * from the browser is a decision to proceed, never the plan itself.
 */
export function GenerateAssignments({ slug, target }: { slug: string; target: number }) {
  const [state, action, pending, keep] = useFormAction(generateAssignmentsAction);
  const preview = state.preview;

  return (
    <form action={action} {...keep} className="px-5 py-5">
      {state.error ? <div className="mb-4"><Notice tone="danger">{state.error}</Notice></div> : null}
      {state.ok ? <div className="mb-4"><Notice tone={preview ? "info" : "success"}>{state.ok}</Notice></div> : null}
      <input type="hidden" name="slug" value={slug} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-foreground">Reviews per project</span>
          <input
            name="reviewsPerProject" type="number" min={1} max={20} defaultValue={state.target ?? target}
            className="font-mono tabular-nums min-h-[44px] w-28 rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground focus:border-primary focus:outline-none"
          />
        </label>
        <Button type="submit" name="intent" value="preview" tone="secondary" disabled={pending}>
          {pending ? "Working…" : "Preview"}
        </Button>
        {preview && preview.created > 0 ? (
          <Button type="submit" name="intent" value="commit" disabled={pending}>
            Create {preview.created} assignment(s)
          </Button>
        ) : null}
      </div>
      <p className="mt-3 max-w-xl text-[12px] text-muted-foreground">
        Existing assignments are kept and counted. Judges are picked by lightest load, skipping anyone on the
        project&rsquo;s own team or outside its track. Running it again after more submissions arrive tops up
        the gaps rather than reshuffling the panel.
      </p>

      {preview ? (
        <div className="mt-5 space-y-4 rounded-[12px] border border-border bg-secondary/40 p-4">
          <p className="text-[13px] text-foreground">
            Across {preview.projectsConsidered} eligible project(s), targeting {preview.target} review(s) each.
            Nothing has been written yet.
          </p>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <h4 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Load per judge, after this batch</h4>
              <ul className="space-y-1">
                {preview.loads.map((l) => (
                  <li key={l.judgeId} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="truncate text-foreground">{l.displayName}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{l.count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Projects still short</h4>
              {preview.coverage.filter((c) => c.short > 0).length === 0 ? (
                <p className="text-[13px] text-success">Every project reaches the target.</p>
              ) : (
                <ul className="space-y-1">
                  {preview.coverage.filter((c) => c.short > 0).slice(0, 12).map((c) => (
                    <li key={c.projectId} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="truncate text-foreground">{c.projectName}</span>
                      <span className="font-mono tabular-nums text-warning">{c.reviews}/{preview.target}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {preview.skipped.length ? (
            <div>
              <h4 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Cannot be filled ({preview.skipped.length})
              </h4>
              <ul className="space-y-1">
                {preview.skipped.slice(0, 12).map((sk) => (
                  <li key={sk.projectId} className="text-[12px] text-muted-foreground">
                    <span className="text-foreground">{sk.projectName}</span> — {sk.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-muted-soft">
                Add judges, widen a track restriction or lower the target; the gap is not hidden by assigning
                someone ineligible.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

export function ComputeResults({ slug }: { slug: string }) {
  const [state, action, pending] = useFormAction(computeResultsAction);
  return (
    <form action={action}>
      {state.error ? <div className="mb-4"><Notice tone="danger">{state.error}</Notice></div> : null}
      {state.ok ? <div className="mb-4"><Notice tone="success">{state.ok}</Notice></div> : null}
      <input type="hidden" name="slug" value={slug} />
      <Button type="submit" tone="secondary" disabled={pending}>
        {pending ? "Computing…" : "Recompute snapshot"}
      </Button>
    </form>
  );
}

const DEFAULT_CRITERIA = [
  { name: "Completeness", weight: 40, description: "How much of the brief is finished and working." },
  { name: "Integrity", weight: 25, description: "Are the rules enforced where they cannot be bypassed?" },
  { name: "Operability", weight: 20, description: "Could a stranger run this without asking a question?" },
  { name: "Craft", weight: 15, description: "Schema, code and interface quality." },
];

export function RubricEditor({ slug, existing }: {
  slug: string;
  existing: { name: string; weight: number; description: string }[] | null;
}) {
  const [state, action, pending, keep] = useFormAction(publishRubricAction);
  const rows = existing?.length ? existing : DEFAULT_CRITERIA;
  return (
    <form action={action} {...keep} className="px-5 py-5">
      {state.error ? <div className="mb-4"><Notice tone="danger">{state.error}</Notice></div> : null}
      {state.ok ? <div className="mb-4"><Notice tone="success">{state.ok}</Notice></div> : null}
      <input type="hidden" name="slug" value={slug} />

      <label className="block max-w-sm">
        <span className="mb-1.5 block text-[13px] font-medium text-foreground">Rubric name</span>
        <input
          name="rubricName" defaultValue="Judging rubric"
          className="min-h-[44px] w-full rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground focus:border-primary focus:outline-none"
        />
      </label>

      <div className="mt-6 space-y-4">
        {rows.map((c, i) => (
          <div key={i} className="grid grid-cols-1 gap-3 rounded-[10px] border border-border p-4 sm:grid-cols-[1fr_110px]">
            <div className="space-y-3">
              <input
                name="criterionName" defaultValue={c.name} placeholder="Criterion name" aria-label={`Criterion ${i + 1} name`}
                className="min-h-[44px] w-full rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground focus:border-primary focus:outline-none"
              />
              <input
                name="criterionDescription" defaultValue={c.description} placeholder="What a judge should look for"
                aria-label={`Criterion ${i + 1} description`}
                className="min-h-[44px] w-full rounded-[10px] border border-control-border bg-background px-3 text-[13px] text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-muted-foreground">Weight</span>
              <input
                name="criterionWeight" type="number" min={0} step={1} defaultValue={c.weight}
                aria-label={`Criterion ${i + 1} weight`}
                className="font-mono tabular-nums min-h-[44px] w-full rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground focus:border-primary focus:outline-none"
              />
            </label>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Publishing…" : "Publish as new version"}</Button>
        <p className="text-[12px] text-muted-foreground">
          Weights are relative, not percentages. Existing reviews keep the version they were scored against.
        </p>
      </div>
    </form>
  );
}

/**
 * An eligibility decision, with the reason it was taken. Disqualifying never
 * edits the team's submission: the entry leaves the gallery, the assignment
 * pool and the results, and the reason is kept beside it.
 */
export function EligibilityControl({ slug, projectId, projectName, disqualified }: {
  slug: string; projectId: string; projectName: string; disqualified: boolean;
}) {
  const [state, action, pending, keep] = useFormAction(setEligibilityAction);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-control-border px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {disqualified ? "Reinstate…" : "Disqualify…"}
        </button>
        {state.ok ? <div className="mt-1 text-[11px] text-success">{state.ok}</div> : null}
      </div>
    );
  }

  return (
    <form action={action} {...keep} className="min-w-[220px] space-y-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="decision" value={disqualified ? "reinstated" : "disqualified"} />
      <label className="block text-[11px] text-muted-foreground">
        Reason, recorded against {projectName}
        <input
          name="reason" required minLength={4} autoFocus
          className="mt-1 min-h-[34px] w-full rounded-[8px] border border-control-border bg-background px-2 text-[12px] text-foreground"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit" disabled={pending}
          className="rounded-md border border-destructive/40 px-2 py-1 text-[12px] text-destructive hover:bg-destructive hover:text-white disabled:opacity-50"
        >
          {pending ? "Working…" : disqualified ? "Reinstate" : "Disqualify"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
      {state.error ? <div className="text-[11px] text-destructive">{state.error}</div> : null}
    </form>
  );
}
