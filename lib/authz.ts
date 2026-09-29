import { all, get } from "./db/client.ts";
import type { Actor } from "./auth/session.ts";

export type EventRole = "participant" | "judge" | "organizer";

/**
 * What an actor may do inside one event.
 *
 * Every domain read and write takes one of these. Nothing in Forgeboard decides
 * access from a URL, a React prop or a hidden button: the capability is resolved
 * from the database on the server for each request, and the domain layer refuses
 * to run without it. See ARCHITECTURE.md, "Authorization".
 */
export type Capability = {
  actor: Actor | null;
  eventId: string;
  isAdmin: boolean;
  isOrganizer: boolean;
  /**
   * True when this actor is only an organizer here because they are an
   * instance admin. Instance-wide access is allowed, but it is not the same
   * thing as running the event, so callers audit it (see auditAdminAccess).
   */
  viaAdmin: boolean;
  isJudge: boolean;
  isParticipant: boolean;
  /** null = judges every track; array = restricted to exactly these track ids. */
  judgeTrackIds: string[] | null;
};

export class AccessDenied extends Error {
  readonly code = "ACCESS_DENIED";
  readonly reason: string;
  constructor(reason: string) {
    super(`Access denied: ${reason}`);
    this.reason = reason;
    this.name = "AccessDenied";
  }
}

export function capabilityFor(actor: Actor | null, eventId: string): Capability {
  const base: Capability = {
    actor, eventId,
    isAdmin: actor?.globalRole === "admin",
    isOrganizer: false, viaAdmin: false, isJudge: false, isParticipant: false,
    judgeTrackIds: null,
  };
  if (!actor) return base;

  const rows = all<{ role: EventRole; track_id: string | null }>(
    `SELECT role, track_id FROM event_roles WHERE event_id = ? AND user_id = ?`,
    eventId, actor.id,
  );

  const granted = rows.some((r) => r.role === "organizer");
  base.isOrganizer = base.isAdmin || granted;
  base.viaAdmin = base.isAdmin && !granted;
  base.isParticipant = rows.some((r) => r.role === "participant");

  const judgeRows = rows.filter((r) => r.role === "judge");
  base.isJudge = judgeRows.length > 0;
  if (base.isJudge) {
    // A single grant with no track means "all tracks"; otherwise the judge is
    // confined to the listed tracks and every query filters on them.
    base.judgeTrackIds = judgeRows.some((r) => r.track_id === null)
      ? null
      : judgeRows.map((r) => r.track_id as string);
  }
  return base;
}

export function requireOrganizer(cap: Capability): void {
  if (!cap.isOrganizer) throw new AccessDenied("organizer role required for this event");
}

export function requireJudge(cap: Capability): void {
  if (!cap.isJudge) throw new AccessDenied("judge role required for this event");
}

export function requireActor(cap: Capability): Actor {
  if (!cap.actor) throw new AccessDenied("sign in required");
  return cap.actor;
}

/** A judge may only ever touch a track they hold a grant for. */
export function judgeMayseeTrack(cap: Capability, trackId: string | null): boolean {
  if (cap.isOrganizer) return true;
  if (!cap.isJudge) return false;
  if (cap.judgeTrackIds === null) return true;
  return trackId !== null && cap.judgeTrackIds.includes(trackId);
}

/** True when the actor belongs to the team that owns the project. */
export function isProjectOwner(actor: Actor | null, projectId: string): boolean {
  if (!actor) return false;
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM projects p
       JOIN team_members tm ON tm.team_id = p.team_id
      WHERE p.id = ? AND tm.user_id = ?`,
    projectId, actor.id,
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Conflict of interest: a judge must never review a project from their own
 * team. Checked when assignments are generated AND again when a review is
 * opened.
 *
 * True when the judge is, or has been, on the team that owns the project.
 * Past membership counts: otherwise a judge could leave the team, lose the
 * conflict and be assigned their own project. team_member_history is written
 * whenever somebody leaves, so the record outlives the membership row.
 */
export function hasConflict(judgeUserId: string, projectId: string): boolean {
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM projects p
      WHERE p.id = ?
        AND (EXISTS (SELECT 1 FROM team_members tm
                      WHERE tm.team_id = p.team_id AND tm.user_id = ?)
          OR EXISTS (SELECT 1 FROM team_member_history h
                      WHERE h.team_id = p.team_id AND h.user_id = ?))`,
    projectId, judgeUserId, judgeUserId,
  );
  return (row?.n ?? 0) > 0;
}
