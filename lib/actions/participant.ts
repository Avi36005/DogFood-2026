"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "../auth/session.ts";
import { capabilityFor } from "../authz.ts";
import * as events from "../domain/events.ts";
import * as teams from "../domain/teams.ts";
import * as projects from "../domain/projects.ts";
import type { FormState } from "./auth.ts";

async function context(slug: string) {
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/team`);
  const event = events.bySlug(slug);
  if (!event) throw new Error("Event not found.");
  return { actor, event, cap: capabilityFor(actor, event.id) };
}

function fail(err: unknown): FormState {
  return { error: err instanceof Error ? err.message : "Something went wrong." };
}

export async function createTeamAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { actor, cap } = await context(slug);
    teams.createTeam(cap, actor, String(fd.get("name") ?? ""));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}/team`);
  return { ok: "Team created." };
}

export async function createInviteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { actor } = await context(slug);
    const token = teams.createInvite(actor, String(fd.get("teamId")), { maxUses: 10, ttlHours: 24 * 14 });
    revalidatePath(`/events/${slug}/team`);
    // The raw token is shown once, here, and never stored in readable form.
    return { ok: `/invite/${token}` };
  } catch (err) { return fail(err); }
}

export async function leaveTeamAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { actor } = await context(slug);
    teams.leaveTeam(actor, String(fd.get("teamId")));
  } catch (err) { return fail(err); }
  redirect(`/events/${slug}`);
}

export async function acceptInviteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const token = String(fd.get("token"));
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/invite/${token}`);
  let slug: string;
  try {
    slug = teams.acceptInvite(actor, token).eventSlug;
  } catch (err) { return fail(err); }
  redirect(`/events/${slug}/team`);
}

export async function saveProjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  const wantsSubmit = fd.get("intent") === "submit";
  try {
    const { actor, cap } = await context(slug);
    const projectId = String(fd.get("projectId"));
    // A multi-choice question posts one value per checked box; they are stored
    // as one answer, one choice per line.
    const answers: Record<string, string> = {};
    for (const key of new Set([...fd.keys()].filter((k) => k.startsWith("q:")))) {
      answers[key.slice(2)] = fd.getAll(key).map(String).filter((v) => v !== "").join("\n");
    }
    projects.saveDraft(
      cap, actor, projectId,
      {
        name: String(fd.get("name") ?? ""),
        tagline: String(fd.get("tagline") ?? ""),
        description: String(fd.get("description") ?? ""),
        track_id: (fd.get("track_id") as string) || null,
        repo_url: String(fd.get("repo_url") ?? ""),
        live_url: String(fd.get("live_url") ?? ""),
        demo_video_url: String(fd.get("demo_video_url") ?? ""),
      },
      String(fd.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      answers,
      Number(fd.get("version")),
    );
    if (wantsSubmit) projects.submit(cap, actor, projectId);
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}/submit`);
  const at = new Date().toISOString().slice(11, 19);
  return {
    ok: wantsSubmit
      ? `Submitted at ${at} UTC. You can keep editing until the deadline.`
      : `Draft saved at ${at} UTC.`,
  };
}

export async function withdrawAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { actor, cap } = await context(slug);
    projects.withdraw(cap, actor, String(fd.get("projectId")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}/submit`);
  return { ok: "Project withdrawn." };
}

export async function uploadMediaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { actor, cap, event } = await context(slug);
    if (!events.submissionsOpen(event) && !cap.isOrganizer) {
      throw new Error("The submission window for this event is closed.");
    }
    const projectId = String(fd.get("projectId"));
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose an image first." };
    const media = await import("../domain/media.ts");
    if (fd.get("slot") === "thumbnail") await media.attachThumbnail(cap, actor, projectId, file);
    else await media.attachGallery(cap, actor, projectId, file);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not upload that image." };
  }
  revalidatePath(`/events/${slug}/submit`);
  return { ok: "Image uploaded." };
}

export async function removeMediaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { actor, cap } = await context(slug);
    const media = await import("../domain/media.ts");
    await media.removeAsset(cap, actor, String(fd.get("projectId")), String(fd.get("assetId")));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not remove that image." };
  }
  revalidatePath(`/events/${slug}/submit`);
  return { ok: "Image removed." };
}
