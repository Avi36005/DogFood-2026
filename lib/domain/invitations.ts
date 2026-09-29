import { randomBytes, createHash } from "node:crypto";
import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { AccessDenied, requireOrganizer, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import { byId as eventById } from "./events.ts";

/**
 * Role invitations: one person, one use, one expiry, one track scope.
 *
 * This is deliberately not the team join link in `teams.ts`. That one is a
 * reusable capacity-limited link for a team; this one names a single role
 * grant, and the scope it grants is read from this row at acceptance, never
 * from the request — a browser cannot widen "one track" into "every track".
 */

export type RoleInvitation = {
  id: string; event_id: string; role: string; track_id: string | null;
  email_ci: string; note: string; created_by: string; created_at: string;
  expires_at: string; accepted_by: string | null; accepted_at: string | null; revoked_at: string | null;
  track_name?: string | null; accepted_name?: string | null;
};

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const DEFAULT_TTL_HOURS = 7 * 24;

export function invitationState(i: RoleInvitation, at = Date.now()): "accepted" | "revoked" | "expired" | "pending" {
  if (i.accepted_at) return "accepted";
  if (i.revoked_at) return "revoked";
  if (Date.parse(i.expires_at) < at) return "expired";
  return "pending";
}

/** Returns the raw token exactly once. Only its hash is stored. */
export function createRoleInvitation(cap: Capability, input: {
  trackId?: string | null; email?: string; note?: string; ttlHours?: number;
}): { token: string; invitation: RoleInvitation } {
  requireOrganizer(cap);
  const trackId = input.trackId || null;
  if (trackId) {
    const ok = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE id = ? AND event_id = ?`, trackId, cap.eventId)!.n;
    if (!ok) throw new Error("That track does not belong to this event.");
  }
  const email = (input.email ?? "").trim().toLowerCase();
  if (email && !email.includes("@")) throw new Error("That does not look like an email address.");

  const token = randomBytes(24).toString("base64url");
  const id = newId("rin");
  run(
    `INSERT INTO role_invitations (id, event_id, role, track_id, email_ci, note, token_hash, created_by, created_at, expires_at)
     VALUES (?,?, 'judge', ?,?,?,?,?,?,?)`,
    id, cap.eventId, trackId, email, (input.note ?? "").slice(0, 200), hashToken(token),
    cap.actor!.id, nowIso(),
    new Date(Date.now() + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 3600e3).toISOString(),
  );
  // The token itself is never written to the audit trail.
  audit.record({
    actor: cap.actor, eventId: cap.eventId, action: "invite.judge.create",
    subjectType: "invitation", subjectId: id, detail: { trackId, addressed: email ? "yes" : "no" },
  });
  return { token, invitation: byId(id)! };
}

export function byId(id: string): RoleInvitation | undefined {
  return get<RoleInvitation>(`SELECT * FROM role_invitations WHERE id = ?`, id);
}

export function listForEvent(cap: Capability): RoleInvitation[] {
  requireOrganizer(cap);
  return all<RoleInvitation>(
    `SELECT i.*, t.name AS track_name, u.display_name AS accepted_name
       FROM role_invitations i
       LEFT JOIN tracks t ON t.id = i.track_id
       LEFT JOIN users u ON u.id = i.accepted_by
      WHERE i.event_id = ?
      ORDER BY i.created_at DESC`,
    cap.eventId,
  );
}

export function revoke(cap: Capability, invitationId: string) {
  requireOrganizer(cap);
  const inv = byId(invitationId);
  if (!inv || inv.event_id !== cap.eventId) throw new AccessDenied("invitation not found in this event");
  if (inv.accepted_at) throw new Error("That invitation has already been accepted. Remove the judge instead.");
  run(`UPDATE role_invitations SET revoked_at = ? WHERE id = ?`, nowIso(), invitationId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "invite.judge.revoke", subjectType: "invitation", subjectId: invitationId });
}

export type InvitationPreview = {
  eventSlug: string; eventName: string; role: string;
  trackName: string | null; note: string; addressedTo: string;
  state: ReturnType<typeof invitationState>;
};

/** What the acceptance page may show before anyone signs in: no token, no ids. */
export function preview(token: string): InvitationPreview | null {
  const row = get<RoleInvitation & { event_slug: string; event_name: string; track_name: string | null }>(
    `SELECT i.*, e.slug AS event_slug, e.name AS event_name, t.name AS track_name
       FROM role_invitations i
       JOIN events e ON e.id = i.event_id
       LEFT JOIN tracks t ON t.id = i.track_id
      WHERE i.token_hash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  return {
    eventSlug: row.event_slug, eventName: row.event_name, role: row.role,
    trackName: row.track_name ?? null, note: row.note,
    // Enough to tell the right person it is for them, without publishing the address.
    addressedTo: row.email_ci ? row.email_ci.replace(/^(.).*(@.*)$/, "$1…$2") : "",
    state: invitationState(row),
  };
}

/**
 * Accepting grants exactly the role and track stored on the invitation, to the
 * signed-in account. One transaction, and the single-use flag is set inside it,
 * so two tabs cannot both spend the same invitation.
 */
export function accept(actor: Actor, token: string): { eventSlug: string; trackName: string | null } {
  // Checked before the transaction: a refusal has to stay on the record, and a
  // write inside a transaction that then throws would be rolled back with it.
  const addressed = get<{ id: string; event_id: string; email_ci: string }>(
    `SELECT id, event_id, email_ci FROM role_invitations WHERE token_hash = ?`, hashToken(token));
  if (addressed?.email_ci && addressed.email_ci !== actor.email.toLowerCase()) {
    audit.record({
      actor, eventId: addressed.event_id, action: "invite.judge.accept", subjectType: "invitation",
      subjectId: addressed.id, outcome: "denied", detail: { reason: "signed in as a different account" },
    });
    throw new Error("This invitation was issued to a different email address. Sign in as that account.");
  }

  return tx(() => {
    const row = get<RoleInvitation & { event_slug: string; track_name: string | null }>(
      `SELECT i.*, e.slug AS event_slug, t.name AS track_name
         FROM role_invitations i
         JOIN events e ON e.id = i.event_id
         LEFT JOIN tracks t ON t.id = i.track_id
        WHERE i.token_hash = ?`,
      hashToken(token),
    );
    if (!row) throw new Error("This invitation link is not valid.");
    const state = invitationState(row);
    if (state === "accepted") throw new Error("This invitation has already been used.");
    if (state === "revoked") throw new Error("This invitation has been revoked.");
    if (state === "expired") throw new Error("This invitation has expired. Ask the organizer for a new one.");
    if (row.email_ci && row.email_ci !== actor.email.toLowerCase()) {
      throw new Error("This invitation was issued to a different email address. Sign in as that account.");
    }

    run(
      `INSERT OR IGNORE INTO event_roles (id, event_id, user_id, role, track_id, granted_by, created_at)
       VALUES (?,?,?, 'judge', ?,?,?)`,
      newId("rol"), row.event_id, actor.id, row.track_id, row.created_by, nowIso(),
    );
    run(`UPDATE role_invitations SET accepted_by = ?, accepted_at = ? WHERE id = ?`, actor.id, nowIso(), row.id);
    audit.record({
      actor, eventId: row.event_id, action: "invite.judge.accept",
      subjectType: "invitation", subjectId: row.id, detail: { trackId: row.track_id },
    });
    return { eventSlug: row.event_slug, trackName: row.track_name ?? null };
  });
}

/**
 * Removing a judge takes effect on the next request: capabilities are resolved
 * from event_roles for every request, so no existing session, download or open
 * page keeps access. Submitted reviews stay exactly as they were — the record
 * of who judged what has to survive the removal — while assignments they had
 * not finished are revoked so the work can be reassigned.
 */
export function removeJudge(cap: Capability, userId: string): { revokedAssignments: number; keptReviews: number } {
  requireOrganizer(cap);
  const event = eventById(cap.eventId);
  if (!event) throw new AccessDenied("event not found");

  return tx(() => {
    run(`DELETE FROM event_roles WHERE event_id = ? AND user_id = ? AND role = 'judge'`, cap.eventId, userId);
    const open = all<{ id: string }>(
      `SELECT a.id FROM assignments a
        LEFT JOIN reviews r ON r.assignment_id = a.id
       WHERE a.event_id = ? AND a.judge_user_id = ? AND a.status != 'revoked'
         AND (r.id IS NULL OR r.status != 'submitted')`,
      cap.eventId, userId,
    );
    for (const a of open) {
      run(`UPDATE assignments SET status = 'revoked', revoked_at = ? WHERE id = ?`, nowIso(), a.id);
    }
    const kept = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments a JOIN reviews r ON r.assignment_id = a.id
        WHERE a.event_id = ? AND a.judge_user_id = ? AND r.status = 'submitted'`,
      cap.eventId, userId,
    )!.n;
    audit.record({
      actor: cap.actor, eventId: cap.eventId, action: "judge.remove", subjectType: "user", subjectId: userId,
      detail: { revokedAssignments: open.length, keptSubmittedReviews: kept },
    });
    return { revokedAssignments: open.length, keptReviews: kept };
  });
}
