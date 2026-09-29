import { all, run, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import type { Actor } from "../auth/session.ts";

export type AuditRow = {
  id: string; event_id: string | null; actor_label: string; action: string;
  subject_type: string; subject_id: string; detail_json: string;
  outcome: string; created_at: string;
};

/**
 * Append-only operator-readable trail. Written for every state change and for
 * every refused attempt, so "who tried to see what" is answerable without a
 * database client. Never updated, never deleted by the application.
 */
export function record(opts: {
  actor: Actor | null;
  eventId?: string | null;
  action: string;
  subjectType?: string;
  subjectId?: string;
  detail?: Record<string, unknown>;
  outcome?: "ok" | "denied";
}): void {
  run(
    `INSERT INTO audit_events
       (id, event_id, actor_user_id, actor_label, action, subject_type, subject_id, detail_json, outcome, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId("aud"),
    opts.eventId ?? null,
    opts.actor?.id ?? null,
    opts.actor ? `${opts.actor.displayName} <${opts.actor.email}>` : "anonymous",
    opts.action,
    opts.subjectType ?? "",
    opts.subjectId ?? "",
    JSON.stringify(opts.detail ?? {}),
    opts.outcome ?? "ok",
    nowIso(),
  );
}

/**
 * An instance admin opening an event they do not organize. The access is
 * allowed — that is what instance administration is — but it is never silent:
 * the organizers of the event can see in their own audit trail that it
 * happened, to what, and when.
 *
 * Repeated views within a few minutes collapse into the first record so that
 * paging around the console does not bury the trail.
 */
export function adminAccess(cap: { actor: Actor | null; eventId: string; viaAdmin: boolean }, what: string): void {
  if (!cap.viaAdmin || !cap.actor) return;
  const since = new Date(Date.now() - 5 * 60e3).toISOString();
  const recent = all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events
      WHERE event_id = ? AND actor_user_id = ? AND action = 'admin.access'
        AND subject_id = ? AND created_at > ?`,
    cap.eventId, cap.actor.id, what, since,
  )[0].n;
  if (recent > 0) return;
  record({
    actor: cap.actor, eventId: cap.eventId, action: "admin.access",
    subjectType: "event", subjectId: what,
    detail: { note: "instance admin, not an organizer of this event" },
  });
}

export function listForEvent(eventId: string, limit = 200, offset = 0): AuditRow[] {
  return all<AuditRow>(
    `SELECT * FROM audit_events WHERE event_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    eventId, limit, offset,
  );
}

export function countForEvent(eventId: string): number {
  return all<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE event_id = ?`, eventId)[0].n;
}
