"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "../auth/session.ts";
import { capabilityFor } from "../authz.ts";
import * as events from "../domain/events.ts";
import * as judging from "../domain/judging.ts";
import * as results from "../domain/results.ts";
import * as invitations from "../domain/invitations.ts";
import * as projects from "../domain/projects.ts";
import type { FormState } from "./auth.ts";

async function context(slug: string, next: string) {
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=${encodeURIComponent(next)}`);
  const event = events.bySlug(slug);
  if (!event) throw new Error("Event not found.");
  return { actor, event, cap: capabilityFor(actor, event.id) };
}

function fail(err: unknown): FormState {
  return { error: err instanceof Error ? err.message : "Something went wrong." };
}

export async function saveReviewAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  const assignmentId = String(fd.get("assignmentId"));
  const wantsSubmit = fd.get("intent") === "submit";
  try {
    const { actor, cap } = await context(slug, `/events/${slug}/judge/${assignmentId}`);
    const scores: Record<string, number> = {};
    const comments: Record<string, string> = {};
    for (const [k, v] of fd.entries()) {
      if (k.startsWith("score:")) {
        const raw = String(v);
        if (raw !== "") scores[k.slice(6)] = Number(raw);
      }
      if (k.startsWith("note:")) comments[k.slice(5)] = String(v);
    }
    judging.saveReview(cap, actor, assignmentId, {
      scores, comments, overall: String(fd.get("overall") ?? ""), submit: wantsSubmit,
    });
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}/judge`, "layout");
  if (wantsSubmit) {
    // "and next" carries an assignment id; openReview refuses it if it is not
    // this judge's, so a tampered value lands them back on their own queue.
    const then = String(fd.get("thenNext") ?? "");
    if (then) {
      try {
        const { actor, cap } = await context(slug, `/events/${slug}/judge`);
        judging.openReview(cap, actor, then);
        redirect(`/events/${slug}/judge/${then}`);
      } catch (err) {
        if (err instanceof Error && "digest" in err) throw err;  // the redirect itself
      }
    }
    redirect(`/events/${slug}/judge`);
  }
  return { ok: `Draft saved at ${new Date().toISOString().slice(11, 19)} UTC. Nobody else can see it.` };
}

export type AssignState = FormState & { preview?: judging.AssignmentPlan; target?: number };

/**
 * Preview first, commit second. The preview is a dry run of the same planner,
 * and the commit re-runs it on the server: what the browser sends back is a
 * request to proceed, never the plan itself.
 */
export async function generateAssignmentsAction(_prev: AssignState, fd: FormData): Promise<AssignState> {
  const slug = String(fd.get("slug"));
  const target = Number(fd.get("reviewsPerProject")) || undefined;
  const commit = fd.get("intent") === "commit";
  try {
    const { cap } = await context(slug, `/events/${slug}/organize`);
    const plan = judging.generateAssignments(cap, { reviewsPerProject: target, dryRun: !commit });
    if (!commit) {
      return {
        preview: plan, target,
        ok: plan.created === 0
          ? "Nothing to assign: every project already has its target number of reviews."
          : `Ready to create ${plan.created} assignment(s).`,
      };
    }
    revalidatePath(`/events/${slug}/organize`, "layout");
    const note = plan.skipped.length
      ? ` ${plan.skipped.length} project(s) could not be fully covered; see the coverage table.`
      : "";
    return { ok: `Created ${plan.created} assignment(s).${note}` };
  } catch (err) { return fail(err); }
}

export type InviteState = FormState & { link?: string };

/**
 * Creates a judge invitation and hands back the link once. Forgeboard sends no
 * email: the organizer passes the link along themselves, and the scope it
 * grants lives on the invitation row, not in the link.
 */
export async function inviteJudgeAction(_prev: InviteState, fd: FormData): Promise<InviteState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize/panel`);
    const { token } = invitations.createRoleInvitation(cap, {
      trackId: (fd.get("trackId") as string) || null,
      email: String(fd.get("email") ?? ""),
      note: String(fd.get("note") ?? ""),
    });
    revalidatePath(`/events/${slug}/organize/panel`);
    return { ok: "Invitation created. Copy the link now — it is shown once.", link: `/invite/judge/${token}` };
  } catch (err) { return fail(err); }
}

export async function revokeInvitationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize/panel`);
    invitations.revoke(cap, String(fd.get("invitationId")));
    revalidatePath(`/events/${slug}/organize/panel`);
    return { ok: "Invitation revoked. The link no longer works." };
  } catch (err) { return fail(err); }
}

export async function removeJudgeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize/panel`);
    const out = invitations.removeJudge(cap, String(fd.get("userId")));
    revalidatePath(`/events/${slug}/organize`, "layout");
    return {
      ok: `Removed from the panel. ${out.revokedAssignments} unfinished assignment(s) released`
        + `, ${out.keptReviews} submitted review(s) kept.`,
    };
  } catch (err) { return fail(err); }
}

/** Accepting a judge invitation. The scope comes from the invitation row. */
export async function acceptJudgeInviteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const token = String(fd.get("token") ?? "");
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/invite/judge/${token}`);
  let slug: string;
  try {
    slug = invitations.accept(actor, token).eventSlug;
  } catch (err) { return fail(err); }
  redirect(`/events/${slug}/judge`);
}

/** Organizer eligibility decision. The submission itself is never rewritten. */
export async function setEligibilityAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize/projects`);
    const decision = fd.get("decision") === "reinstated" ? "reinstated" : "disqualified";
    projects.setEligibility(cap, String(fd.get("projectId")), decision, String(fd.get("reason") ?? ""));
    revalidatePath(`/events/${slug}`, "layout");
    return {
      ok: decision === "disqualified"
        ? "Disqualified. It leaves the gallery, the assignment pool and the results."
        : "Reinstated. It is eligible again; recompute results to include it.",
    };
  } catch (err) { return fail(err); }
}

export async function publishRubricAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize`);
    const names = fd.getAll("criterionName").map(String);
    const weights = fd.getAll("criterionWeight").map((w) => Number(w));
    const descriptions = fd.getAll("criterionDescription").map(String);
    const items = names
      .map((name, i) => ({ name: name.trim(), weight: weights[i] ?? 0, description: descriptions[i] ?? "" }))
      .filter((i) => i.name);
    if (!items.length) return { error: "Add at least one criterion." };
    const rubric = judging.createRubricVersion(cap, String(fd.get("rubricName") ?? "Rubric"), items);
    judging.publishRubric(cap, rubric.id);
    revalidatePath(`/events/${slug}/organize`);
    return { ok: `Published rubric version ${rubric.version}.` };
  } catch (err) { return fail(err); }
}

export async function computeResultsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize`);
    const snap = results.computeSnapshot(cap);
    revalidatePath(`/events/${slug}/organize`);
    return { ok: `Snapshot computed at ${snap.computed_at.slice(11, 19)} UTC. Nothing is public until you publish it.` };
  } catch (err) { return fail(err); }
}

export async function publishResultsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize`);
    results.publish(cap, String(fd.get("snapshotId")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`);
  redirect(`/events/${slug}/results`);
}

export async function setStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await context(slug, `/events/${slug}/organize`);
    events.setStatus(cap, String(fd.get("status")) as events.EventStatus);
    revalidatePath(`/events/${slug}/organize`);
    return { ok: `Event moved to ${String(fd.get("status")).replace(/_/g, " ")}.` };
  } catch (err) { return fail(err); }
}
