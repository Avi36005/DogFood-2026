"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentActor } from "../auth/session.ts";
import { capabilityFor } from "../authz.ts";
import * as events from "../domain/events.ts";
import { mayCreateEvent, setSetting } from "../domain/instance.ts";
import type { FormState } from "./auth.ts";

export async function createEventAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await currentActor();
  if (!actor) redirect("/signin?next=/events/new");
  const gate = mayCreateEvent(actor);
  if (!gate.allowed) return { error: gate.reason };

  let slug: string;
  try {
    const name = String(fd.get("name") ?? "").trim();
    if (name.length < 2) return { error: "Give the event a name." };
    const event = events.createEvent(actor, {
      name,
      tagline: String(fd.get("tagline") ?? ""),
      description: String(fd.get("description") ?? ""),
      timezone: String(fd.get("timezone") ?? "UTC"),
    });
    slug = event.slug;

    const cap = capabilityFor(actor, event.id);
    const patch: Record<string, string | number | null> = {};
    for (const key of ["submissions_open_at", "submissions_close_at", "judging_open_at", "judging_close_at"]) {
      const raw = String(fd.get(key) ?? "").trim();
      // datetime-local gives "YYYY-MM-DDTHH:mm" with no zone; the form states
      // that the value is read as UTC, and we store it that way.
      if (raw) patch[key] = new Date(raw + ":00Z").toISOString();
    }
    const size = Number(fd.get("max_team_size"));
    if (Number.isFinite(size) && size >= 1 && size <= 50) patch.max_team_size = size;
    const per = Number(fd.get("reviews_per_project"));
    if (Number.isFinite(per) && per >= 1 && per <= 20) patch.reviews_per_project = per;

    if (patch.submissions_open_at && patch.submissions_close_at
        && String(patch.submissions_close_at) <= String(patch.submissions_open_at)) {
      return { error: "Submissions must close after they open." };
    }
    if (Object.keys(patch).length) events.updateEvent(cap, patch as never);

    for (const line of String(fd.get("tracks") ?? "").split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 20)) {
      events.addTrack(cap, line);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not create that event." };
  }
  revalidatePath("/events");
  redirect(`/events/${slug}/organize`);
}

/** Shared organizer context for the setup screens. */
async function organizerFor(slug: string) {
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/organize/setup`);
  const event = events.bySlug(slug);
  if (!event) throw new Error("Event not found.");
  return { actor, event, cap: capabilityFor(actor, event.id) };
}

function fail(err: unknown): FormState {
  return { error: err instanceof Error ? err.message : "Something went wrong." };
}

/** Reads a datetime-local field. The form states that the value is UTC. */
function utcField(fd: FormData, key: string): string | null {
  const raw = String(fd.get(key) ?? "").trim();
  return raw ? new Date(raw + ":00Z").toISOString() : null;
}

export async function updateEventAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await organizerFor(slug);
    const name = String(fd.get("name") ?? "").trim();
    if (name.length < 2) return { error: "Give the event a name." };
    const size = Number(fd.get("max_team_size"));
    const per = Number(fd.get("reviews_per_project"));
    if (!Number.isFinite(size) || size < 1 || size > 50) return { error: "Team size must be between 1 and 50." };
    if (!Number.isFinite(per) || per < 1 || per > 20) return { error: "Reviews per project must be between 1 and 20." };

    events.updateEvent(cap, {
      name,
      tagline: String(fd.get("tagline") ?? "").trim(),
      description: String(fd.get("description") ?? "").trim(),
      timezone: String(fd.get("timezone") ?? "UTC"),
      submissions_open_at: utcField(fd, "submissions_open_at"),
      submissions_close_at: utcField(fd, "submissions_close_at"),
      judging_open_at: utcField(fd, "judging_open_at"),
      judging_close_at: utcField(fd, "judging_close_at"),
      max_team_size: size,
      reviews_per_project: per,
    }, Number(fd.get("version")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: "Event settings saved." };
}

export async function addTrackAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await organizerFor(slug);
    const name = String(fd.get("name") ?? "").trim();
    if (name.length < 2) return { error: "Give the track a name." };
    events.addTrack(cap, name, String(fd.get("description") ?? "").trim());
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: "Track added." };
}

export async function removeTrackAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await organizerFor(slug);
    events.removeTrack(cap, String(fd.get("trackId")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: "Track removed." };
}

export async function addPrizeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await organizerFor(slug);
    const name = String(fd.get("name") ?? "").trim();
    if (name.length < 2) return { error: "Give the prize a name." };
    events.addPrize(cap, {
      name,
      amountText: String(fd.get("amount_text") ?? "").trim(),
      description: String(fd.get("description") ?? "").trim(),
      trackId: (fd.get("trackId") as string) || null,
    });
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: "Prize added." };
}

export async function removePrizeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await organizerFor(slug);
    events.removePrize(cap, String(fd.get("prizeId")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: "Prize removed." };
}

export async function addQuestionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await organizerFor(slug);
    events.addQuestion(cap, {
      prompt: String(fd.get("prompt") ?? ""),
      kind: String(fd.get("kind") ?? "short_text"),
      helpText: String(fd.get("help_text") ?? ""),
      required: fd.get("required") === "on",
      isPublic: fd.get("is_public") === "on",
      options: String(fd.get("options") ?? "").split("\n").map((o) => o.trim()).filter(Boolean),
    });
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: "Question added to the submission form." };
}

export async function removeQuestionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap } = await organizerFor(slug);
    events.removeQuestion(cap, String(fd.get("questionId")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: "Question removed." };
}

export async function setInstanceSettingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await currentActor();
  if (!actor) redirect("/signin?next=/admin");
  try {
    setSetting(actor, String(fd.get("key")), String(fd.get("value")));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save that setting." };
  }
  revalidatePath("/admin");
  return { ok: "Setting saved." };
}
