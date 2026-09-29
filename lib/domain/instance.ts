import { get, run, nowIso } from "../db/client.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";

/** Who may create an event on this instance. Default is deliberately stated. */
export type EventCreationPolicy = "any_signed_in" | "admin_only";

const DEFAULTS: Record<string, string> = {
  event_creation: "any_signed_in",
  instance_name: "Forgeboard",
};

export function setting(key: string): string {
  return get<{ value: string }>(`SELECT value FROM instance_settings WHERE key = ?`, key)?.value
    ?? DEFAULTS[key] ?? "";
}

export function setSetting(admin: Actor, key: string, value: string) {
  if (admin.globalRole !== "admin") throw new Error("Only an instance admin can change settings.");
  run(
    `INSERT INTO instance_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key, value, nowIso(), admin.id,
  );
  audit.record({ actor: admin, action: "instance.setting", subjectType: "setting", subjectId: key, detail: { value } });
}

export function eventCreationPolicy(): EventCreationPolicy {
  return setting("event_creation") === "admin_only" ? "admin_only" : "any_signed_in";
}

/**
 * Creating an event makes you the organizer *of that event only*. It never
 * grants instance-wide powers, and a visitor is never elevated automatically:
 * they must sign in, and the host's policy must permit it.
 */
export function mayCreateEvent(actor: Actor | null): { allowed: boolean; reason: string } {
  if (!actor) return { allowed: false, reason: "Sign in to create an event." };
  if (eventCreationPolicy() === "admin_only" && actor.globalRole !== "admin") {
    return {
      allowed: false,
      reason: "This instance is configured so that only an administrator can create events. Ask the host to create one, or to grant you an organizer role on an existing event.",
    };
  }
  return { allowed: true, reason: "" };
}
