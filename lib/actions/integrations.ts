"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentActor } from "../auth/session.ts";
import { capabilityFor } from "../authz.ts";
import * as events from "../domain/events.ts";
import * as webhooks from "../domain/webhooks.ts";
import * as portability from "../domain/portability.ts";
import * as keys from "../api/keys.ts";
import type { FormState } from "./auth.ts";

async function cap(slug: string) {
  const actor = await currentActor();
  if (!actor) redirect(`/signin?next=/events/${slug}/organize/integrations`);
  const event = events.bySlug(slug);
  if (!event) throw new Error("Event not found.");
  return { actor, cap: capabilityFor(actor, event.id) };
}
const fail = (err: unknown): FormState => ({ error: err instanceof Error ? err.message : "Something went wrong." });

export async function issueKeyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap: c } = await cap(slug);
    const token = keys.issue(c, String(fd.get("label") ?? "key"), fd.get("write") === "on" ? "read,write" : "read");
    revalidatePath(`/events/${slug}/organize/integrations`);
    return { ok: token };   // shown once, never retrievable again
  } catch (err) { return fail(err); }
}

export async function revokeKeyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap: c } = await cap(slug);
    keys.revoke(c, String(fd.get("keyId")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}/organize/integrations`);
  return { ok: "Key revoked." };
}

export async function addWebhookAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap: c } = await cap(slug);
    const topics = fd.getAll("topic").map(String);
    const hook = await webhooks.register(c, String(fd.get("url") ?? ""), topics);
    revalidatePath(`/events/${slug}/organize/integrations`);
    return { ok: `Webhook registered. Signing secret (shown once): ${hook.secret}` };
  } catch (err) { return fail(err); }
}

export async function removeWebhookAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { cap: c } = await cap(slug);
    webhooks.remove(c, String(fd.get("webhookId")));
  } catch (err) { return fail(err); }
  revalidatePath(`/events/${slug}/organize/integrations`);
  return { ok: "Webhook removed." };
}

export async function importBundleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("slug"));
  try {
    const { actor } = await cap(slug);
    const file = fd.get("bundle");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a bundle file first." };
    if (file.size > 20 * 1024 * 1024) return { error: "Bundle files are limited to 20 MB." };
    const parsed = JSON.parse(await file.text());
    const report = portability.importBundle(actor, parsed, { dryRun: fd.get("dryRun") === "on" });
    if (!report.ok) {
      return { error: `Import refused. ${report.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join(" ")}` };
    }
    revalidatePath("/events");
    return {
      ok: report.dryRun
        ? `Dry run passed: ${Object.entries(report.counts).map(([k, v]) => `${v} ${k}`).join(", ")}. Nothing was written.`
        : `Imported as a new draft event (${report.eventSlug}).`,
    };
  } catch (err) { return fail(err); }
}
