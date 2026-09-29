"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentActor } from "../auth/session.ts";
import { capabilityFor } from "../authz.ts";
import * as events from "../domain/events.ts";
import * as records from "../domain/records.ts";
import type { FormState } from "./auth.ts";

/** Public: verification needs no account, by design. */
export async function verifyArtifactAction(json: string) {
  const result = records.verifyArtifact(json);
  return result.valid
    ? { valid: true as const, payload: result.payload }
    : { valid: false as const, reason: result.reason };
}

export async function issueRecordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const actor = await currentActor();
    if (!actor) redirect("/signin");
    const event = events.bySlug(slug);
    if (!event) return { error: "Event not found." };
    records.issueJudgeRecord(capabilityFor(actor, event.id), String(fd.get("judgeUserId")));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not issue that record." };
  }
  revalidatePath(`/events/${slug}/organize/panel`);
  return { ok: "Record issued and signed." };
}
