import { randomBytes, createHash } from "node:crypto";
import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { AccessDenied, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import { byId as eventById } from "./events.ts";

export type TeamRow = { id: string; event_id: string; name: string; created_by: string; created_at: string };
export type MemberRow = { id: string; team_id: string; user_id: string; role: string; joined_at: string; display_name: string; email: string };

function hashToken(t: string) { return createHash("sha256").update(t).digest("hex"); }

export function teamForUser(eventId: string, userId: string): TeamRow | undefined {
  return get<TeamRow>(
    `SELECT t.* FROM teams t
       JOIN team_members m ON m.team_id = t.id
      WHERE t.event_id = ? AND m.user_id = ?`,
    eventId, userId,
  );
}

export function members(teamId: string): MemberRow[] {
  return all<MemberRow>(
    `SELECT m.*, u.display_name, u.email
       FROM team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? ORDER BY m.role DESC, m.joined_at`,
    teamId,
  );
}

export function listTeams(eventId: string): (TeamRow & { member_count: number })[] {
  return all<TeamRow & { member_count: number }>(
    `SELECT t.*, (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count
       FROM teams t WHERE t.event_id = ? ORDER BY t.created_at`,
    eventId,
  );
}

/** Creating a team also grants the participant role for that event. */
export function createTeam(cap: Capability, actor: Actor, name: string): TeamRow {
  const event = eventById(cap.eventId);
  if (!event) throw new AccessDenied("event not found");
  if (!["open", "draft"].includes(event.status) && !cap.isOrganizer) {
    throw new Error("Team formation is closed for this event.");
  }
  if (teamForUser(cap.eventId, actor.id)) {
    throw new Error("You are already on a team for this event.");
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) throw new Error("Team name must be 1-80 characters.");

  return tx(() => {
    const id = newId("tem");
    const now = nowIso();
    try {
      run(`INSERT INTO teams (id, event_id, name, created_by, created_at) VALUES (?,?,?,?,?)`,
        id, cap.eventId, trimmed, actor.id, now);
    } catch {
      throw new Error("A team with that name already exists in this event.");
    }
    run(`INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?,?,?, 'owner', ?)`,
      newId("tmm"), id, actor.id, now);
    run(`INSERT OR IGNORE INTO event_roles (id, event_id, user_id, role, granted_by, created_at)
         VALUES (?,?,?, 'participant', ?, ?)`,
      newId("rol"), cap.eventId, actor.id, actor.id, now);
    audit.record({ actor, eventId: cap.eventId, action: "team.create", subjectType: "team", subjectId: id, detail: { name: trimmed } });
    return get<TeamRow>(`SELECT * FROM teams WHERE id = ?`, id)!;
  });
}

/** Returns the raw invite token exactly once; only its hash is stored. */
export function createInvite(actor: Actor, teamId: string, opts: { maxUses?: number; ttlHours?: number } = {}): string {
  const isMember = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?`, teamId, actor.id);
  if ((isMember?.n ?? 0) === 0) throw new AccessDenied("only a team member can invite");

  const token = randomBytes(24).toString("base64url");
  const team = get<TeamRow>(`SELECT * FROM teams WHERE id = ?`, teamId)!;
  run(
    `INSERT INTO invitations (id, team_id, token_hash, created_by, created_at, expires_at, max_uses, uses)
     VALUES (?,?,?,?,?,?,?,0)`,
    newId("inv"), teamId, hashToken(token), actor.id, nowIso(),
    opts.ttlHours ? new Date(Date.now() + opts.ttlHours * 3600e3).toISOString() : null,
    opts.maxUses ?? 10,
  );
  audit.record({ actor, eventId: team.event_id, action: "invite.create", subjectType: "team", subjectId: teamId });
  return token;
}

export type InvitePreview = { teamId: string; teamName: string; eventId: string; eventSlug: string; eventName: string; memberCount: number; maxTeamSize: number };

export function previewInvite(token: string): InvitePreview | null {
  const row = get<{
    team_id: string; team_name: string; event_id: string; event_slug: string; event_name: string;
    max_team_size: number; expires_at: string | null; revoked_at: string | null; uses: number; max_uses: number;
  }>(
    `SELECT i.team_id, t.name AS team_name, e.id AS event_id, e.slug AS event_slug, e.name AS event_name,
            e.max_team_size, i.expires_at, i.revoked_at, i.uses, i.max_uses
       FROM invitations i
       JOIN teams t ON t.id = i.team_id
       JOIN events e ON e.id = t.event_id
      WHERE i.token_hash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  if (row.uses >= row.max_uses) return null;
  const count = get<{ n: number }>(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?`, row.team_id)!.n;
  return {
    teamId: row.team_id, teamName: row.team_name, eventId: row.event_id,
    eventSlug: row.event_slug, eventName: row.event_name,
    memberCount: count, maxTeamSize: row.max_team_size,
  };
}

/**
 * Accepting an invite is one transaction: the seat check, the membership insert
 * and the use counter move together or not at all, so two people racing for the
 * last seat cannot both win.
 */
export function acceptInvite(actor: Actor, token: string): { teamId: string; eventSlug: string } {
  return tx(() => {
    const row = get<{
      id: string; team_id: string; event_id: string; event_slug: string; max_team_size: number;
      expires_at: string | null; revoked_at: string | null; uses: number; max_uses: number;
    }>(
      `SELECT i.id, i.team_id, t.event_id, e.slug AS event_slug, e.max_team_size,
              i.expires_at, i.revoked_at, i.uses, i.max_uses
         FROM invitations i
         JOIN teams t ON t.id = i.team_id
         JOIN events e ON e.id = t.event_id
        WHERE i.token_hash = ?`,
      hashToken(token),
    );
    if (!row) throw new Error("This invite link is not valid.");
    if (row.revoked_at) throw new Error("This invite link has been revoked.");
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) throw new Error("This invite link has expired.");
    if (row.uses >= row.max_uses) throw new Error("This invite link has been used the maximum number of times.");

    const already = get<{ n: number }>(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?`, row.team_id, actor.id)!.n;
    if (already > 0) return { teamId: row.team_id, eventSlug: row.event_slug };

    const otherTeam = teamForUser(row.event_id, actor.id);
    if (otherTeam) throw new Error("You are already on a different team for this event.");

    const count = get<{ n: number }>(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?`, row.team_id)!.n;
    if (count >= row.max_team_size) throw new Error(`This team is full (${row.max_team_size} members).`);

    const now = nowIso();
    run(`INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?,?,?, 'member', ?)`,
      newId("tmm"), row.team_id, actor.id, now);
    run(`INSERT OR IGNORE INTO event_roles (id, event_id, user_id, role, granted_by, created_at)
         VALUES (?,?,?, 'participant', ?, ?)`,
      newId("rol"), row.event_id, actor.id, actor.id, now);
    run(`UPDATE invitations SET uses = uses + 1 WHERE id = ?`, row.id);
    audit.record({ actor, eventId: row.event_id, action: "invite.accept", subjectType: "team", subjectId: row.team_id });
    return { teamId: row.team_id, eventSlug: row.event_slug };
  });
}

export function leaveTeam(actor: Actor, teamId: string) {
  const team = get<TeamRow>(`SELECT * FROM teams WHERE id = ?`, teamId);
  if (!team) throw new Error("Team not found.");
  const mems = members(teamId);
  const me = mems.find((m) => m.user_id === actor.id);
  if (!me) throw new AccessDenied("not a member of this team");
  if (me.role === "owner" && mems.length > 1) {
    throw new Error("Hand ownership to another member before leaving.");
  }
  tx(() => {
    // The membership row goes, the fact that it existed does not: judging
    // conflicts are decided from both (see authz.hasConflict).
    run(
      `INSERT INTO team_member_history (id, team_id, user_id, joined_at, left_at, reason)
       VALUES (?,?,?,?,?, 'left')`,
      newId("tmh"), teamId, actor.id, me.joined_at, nowIso(),
    );
    run(`DELETE FROM team_members WHERE team_id = ? AND user_id = ?`, teamId, actor.id);
    audit.record({ actor, eventId: team.event_id, action: "team.leave", subjectType: "team", subjectId: teamId });
  });
}
