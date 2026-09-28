import type { Store } from '../db/store.ts';
import { conflict, forbidden, ValidationError } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { hashToken, newId, newToken } from '../util/tokens.ts';
import { addDays, iso } from '../util/time.ts';
import { grantRole, requireUser } from './access.ts';
import { record } from './audit.ts';
import { assertSubmissionsOpen, getEvent } from './events.ts';
import type { Actor, EventRow, TeamRow } from './types.ts';

export const INVITE_DAYS = 14;

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  is_captain: 0 | 1;
  joined_at: string;
}

export function myTeam(store: Store, userId: string, eventId: string): TeamRow | undefined {
  return store.get<TeamRow>(
    `SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id
     WHERE m.user_id = ? AND t.event_id = ?`,
    [userId, eventId],
  );
}

export function teamMembers(store: Store, teamId: string): MemberRow[] {
  return store.all<MemberRow>(
    `SELECT u.id, u.name, u.email, m.is_captain, m.joined_at FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? ORDER BY m.is_captain DESC, m.joined_at, u.name`,
    [teamId],
  );
}

export function isMember(store: Store, userId: string, teamId: string): boolean {
  return store.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]) !== undefined;
}

function isCaptain(store: Store, userId: string, teamId: string): boolean {
  return store.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND is_captain = 1', [teamId, userId]) !== undefined;
}

/** Replaces the team's invite link. Old links stop working at once. */
function issueInvite(store: Store, actor: Actor, team: TeamRow): string {
  const token = newToken();
  const now = iso(actor.now);
  store.run('UPDATE team_invites SET revoked_at = ? WHERE team_id = ? AND revoked_at IS NULL', [now, team.id]);
  store.run('INSERT INTO team_invites (token_hash, team_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [
    hashToken(token), team.id, actor.user?.id ?? null, now, iso(addDays(actor.now, INVITE_DAYS)),
  ]);
  return token;
}

export function createTeam(store: Store, actor: Actor, event: EventRow, body: Body): { team: TeamRow; inviteToken: string } {
  const user = requireUser(actor);
  const form = new FormReader(body);
  const name = form.text('name', { label: 'Team name', required: true, max: 80 });
  form.assertValid();

  return store.tx(() => {
    assertSubmissionsOpen(event, actor.now);
    if (myTeam(store, user.id, event.id)) throw conflict('You are already on a team for this event.');
    if (store.get('SELECT 1 FROM teams WHERE event_id = ? AND name = ?', [event.id, name])) {
      throw new ValidationError({ name: 'Another team already uses this name.' });
    }
    if (store.get("SELECT 1 FROM event_roles WHERE event_id = ? AND user_id = ? AND role IN ('judge', 'organizer')", [event.id, user.id])) {
      throw forbidden('Judges and organizers of an event cannot compete in it.');
    }
    const now = iso(actor.now);
    const team: TeamRow = { id: newId('tm'), event_id: event.id, name, created_by: user.id, created_at: now };
    store.run('INSERT INTO teams (id, event_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [
      team.id, team.event_id, team.name, team.created_by, team.created_at,
    ]);
    store.run('INSERT INTO team_members (team_id, event_id, user_id, is_captain, joined_at) VALUES (?, ?, ?, 1, ?)', [team.id, event.id, user.id, now]);
    grantRole(store, event.id, user.id, 'participant', user.id, now);
    const inviteToken = issueInvite(store, actor, team);
    record(store, actor, { eventId: event.id, action: 'team.created', subjectType: 'team', subjectId: team.id, summary: `${user.name} created the team ${name}.` });
    return { team, inviteToken };
  });
}

