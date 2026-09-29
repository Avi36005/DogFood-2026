"use server";

import { cookies, headers } from "next/headers";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "../auth/session.ts";
import { capabilityFor } from "../authz.ts";
import * as events from "../domain/events.ts";
import * as voting from "../domain/voting.ts";
import * as comments from "../domain/comments.ts";
import type { FormState } from "./auth.ts";
import { VOTER_COOKIE } from "../voter-cookie.ts";

/** The voter cookie is an opaque server-issued value; only its hash is stored. */
async function voterCookie(create: boolean): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(VOTER_COOKIE)?.value;
  if (existing) return existing;
  if (!create) return null;
  const token = randomBytes(24).toString("base64url");
  jar.set(VOTER_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production" && process.env.FORGEBOARD_INSECURE_COOKIES !== "1",
    maxAge: 60 * 60 * 24 * 60,
  });
  return token;
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  // Only meaningful behind a proxy that sets it; treated as a weak signal.
  return h.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
}

export async function castVoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  const projectId = String(fd.get("projectId"));
  const retract = fd.get("intent") === "retract";
  try {
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    const actor = await currentActor();
    const { voter, needs } = voting.resolveVoter(event, {
      actor, voterCookie: await voterCookie(true), ip: await clientIp(),
    });
    if (needs === "sign_in") redirect(`/signin?next=/events/${slug}/vote`);
    if (needs === "email_verification") return { error: "Verify your email address to vote." };
    if (!voter) return { error: "Could not start a voting session." };

    const outcome = retract
      ? voting.retractVote(event, voter, projectId)
      : voting.castVote(event, voter, projectId, await clientIp());
    revalidatePath(`/events/${slug}/vote`);
    // Confirmation speaks only about this voter's own action, never totals.
    return { ok: outcome === "retracted" ? "Vote withdrawn." : "Your vote is saved." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not record that vote." };
  }
}

export async function requestVoteTokenAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    const { token } = voting.issueEmailToken(event, String(fd.get("email") ?? ""));
    // Forgeboard sends no mail. The organizer distributes tokens through their
    // own channel; on a local instance the link is shown here so the mode is
    // usable and the limitation is visible rather than pretended away.
    return { ok: `/events/${slug}/vote?token=${token}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not issue a verification link." };
  }
}

export async function redeemVoteTokenAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    voting.redeemEmailToken(event, String(fd.get("token")), (await voterCookie(true))!, await clientIp());
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not verify that link." };
  }
  redirect(`/events/${slug}/vote`);
}

export async function addCommentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  const projectId = String(fd.get("projectId"));
  const body = String(fd.get("body") ?? "");
  try {
    const actor = await currentActor();
    if (!actor) redirect(`/signin?next=/events/${slug}/projects/${projectId}`);
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    comments.add(capabilityFor(actor, event.id), actor, projectId, body);
  } catch (err) {
    // The typed text is preserved by the form itself on failure.
    return { error: err instanceof Error ? err.message : "Could not post that comment." };
  }
  revalidatePath(`/events/${slug}/projects/${projectId}`);
  return { ok: "Comment posted." };
}

export async function moderateCommentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const actor = await currentActor();
    if (!actor) redirect("/signin");
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    const cap = capabilityFor(actor, event.id);
    if (fd.get("intent") === "restore") comments.restore(cap, String(fd.get("commentId")));
    else comments.remove(cap, actor, String(fd.get("commentId")), String(fd.get("reason") ?? ""));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not moderate that comment." };
  }
  revalidatePath(`/events/${slug}/organize/community`);
  return { ok: "Done." };
}

export async function invalidateVotesAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const actor = await currentActor();
    if (!actor) redirect("/signin");
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    voting.invalidateVotes(capabilityFor(actor, event.id), String(fd.get("voterId")), String(fd.get("reason") ?? ""));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not invalidate those votes." };
  }
  revalidatePath(`/events/${slug}/organize/community`);
  return { ok: "Votes invalidated and the voter blocked." };
}

export async function saveVotingSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const actor = await currentActor();
    if (!actor) redirect("/signin");
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    const cap = capabilityFor(actor, event.id);
    const iso = (k: string) => {
      const raw = String(fd.get(k) ?? "").trim();
      return raw ? new Date(raw + ":00Z").toISOString() : null;
    };
    events.updateEvent(cap, {
      voting_enabled: fd.get("voting_enabled") === "on" ? 1 : 0,
      voting_mode: String(fd.get("voting_mode") ?? "authenticated"),
      votes_per_voter: Number(fd.get("votes_per_voter")) || 3,
      voting_results_public: fd.get("voting_results_public") === "on" ? 1 : 0,
      comments_enabled: fd.get("comments_enabled") === "on" ? 1 : 0,
      voting_open_at: iso("voting_open_at"),
      voting_close_at: iso("voting_close_at"),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save those settings." };
  }
  revalidatePath(`/events/${slug}/organize/community`);
  return { ok: "Community settings saved." };
}
