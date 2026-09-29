import type { Store } from '../db/store.ts';
import { conflict, notFound, ValidationError } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { hashToken, newId, newToken } from '../util/tokens.ts';
import { addDays, iso } from '../util/time.ts';
import { AccessDenied, grantRole, requireOrganizer, requireRole, requireUser, rolesIn } from './access.ts';
import { ensureUser, findUserByEmail } from './accounts.ts';
import { actorLabel, record } from './audit.ts';
import { planAssignments, type PlanJudge, type PlanProject, type Shortfall } from './assignment.ts';
import { assertJudgingOpen, getEvent, judgingOpen, listCriteria, listTracks } from './events.ts';
import { hashPassword, passwordProblem } from './passwords.ts';
import { weightedScore } from './normalization.ts';
import type { Actor, AssignmentRow, CriterionRow, EventRow, ProjectRow, ReviewRow, UserRow } from './types.ts';

export const JUDGE_INVITE_DAYS = 14;

// Judges ------------------------------------------------------------------------------

export interface JudgeSummary {
  id: string;
  name: string;
  email: string;
  has_password: 0 | 1;
  accepted_at: string | null;
  invited: 0 | 1;
  track_ids: string;
  assigned: number;
  submitted: number;
  drafts: number;
  last_activity: string | null;
}

export function listJudges(store: Store, eventId: string): (Omit<JudgeSummary, 'track_ids'> & { trackIds: string[] })[] {
  const rows = store.all<JudgeSummary>(
    `SELECT u.id, u.name, u.email, (u.password_hash IS NOT NULL) AS has_password,
       (SELECT max(accepted_at) FROM judge_invites i WHERE i.event_id = r.event_id AND i.user_id = u.id) AS accepted_at,
       EXISTS (SELECT 1 FROM judge_invites i WHERE i.event_id = r.event_id AND i.user_id = u.id) AS invited,
       coalesce((SELECT group_concat(track_id) FROM judge_tracks jt WHERE jt.event_id = r.event_id AND jt.judge_id = u.id), '') AS track_ids,
       (SELECT count(*) FROM assignments a WHERE a.event_id = r.event_id AND a.judge_id = u.id) AS assigned,
       (SELECT count(*) FROM assignments a JOIN reviews v ON v.assignment_id = a.id
          WHERE a.event_id = r.event_id AND a.judge_id = u.id AND v.status = 'submitted') AS submitted,
       (SELECT count(*) FROM assignments a JOIN reviews v ON v.assignment_id = a.id
          WHERE a.event_id = r.event_id AND a.judge_id = u.id AND v.status = 'draft') AS drafts,
       -- Imported reviews carry no real time, so they only count once someone edits them.
       (SELECT max(v.updated_at) FROM assignments a JOIN reviews v ON v.assignment_id = a.id
          WHERE a.event_id = r.event_id AND a.judge_id = u.id AND (a.source <> 'fixture' OR v.updated_at > a.created_at)) AS last_activity
     FROM event_roles r JOIN users u ON u.id = r.user_id
     WHERE r.event_id = ? AND r.role = 'judge' ORDER BY u.name`,
    [eventId],
  );
  return rows.map(({ track_ids, ...row }) => ({ ...row, trackIds: track_ids ? track_ids.split(',') : [] }));
}

function readTrackIds(form: FormReader, event: EventRow, store: Store): string[] {
  const valid = new Set(listTracks(store, event.id).map((t) => t.id));
  const chosen = form.all('track_ids');
  if (chosen.some((id) => !valid.has(id))) form.fail('track_ids', 'Choose tracks from this event.');
  return [...new Set(chosen)].filter((id) => valid.has(id));
}

function replaceTracks(store: Store, eventId: string, judgeId: string, trackIds: string[]): void {
  store.run('DELETE FROM judge_tracks WHERE event_id = ? AND judge_id = ?', [eventId, judgeId]);
  for (const trackId of trackIds) {
    store.run('INSERT INTO judge_tracks (event_id, judge_id, track_id) VALUES (?, ?, ?)', [eventId, judgeId, trackId]);
  }
}

/**
 * Grants the judge role to an email (creating the person without a password if needed) and
 * returns a one-time link. There is no mail server: the organizer passes the link on.
 */
export function inviteJudge(store: Store, actor: Actor, event: EventRow, body: Body): { user: UserRow; token: string } {
  const organizer = requireOrganizer(store, actor, event, `invite a judge to ${event.name}`);
  const form = new FormReader(body);
  const name = form.text('name', { label: 'Name', required: true, max: 120 });
  const email = form.email('email');
  const trackIds = readTrackIds(form, event, store);
  form.assertValid();

  return store.tx(() => {
    const existing = findUserByEmail(store, email);
    if (existing) {
      const roles = rolesIn(store, existing.id, event.id);
      if (roles.has('participant')) throw new ValidationError({ email: 'This person is on a team in this event, so they cannot judge it.' });
      if (roles.has('organizer')) throw new ValidationError({ email: 'Organizers can read every score, so they cannot also be judges.' });
    }
    const now = iso(actor.now);
    const user = existing ?? ensureUser(store, email, name, actor.now);
    grantRole(store, event.id, user.id, 'judge', organizer.id, now);
    replaceTracks(store, event.id, user.id, trackIds);
    const token = newToken();
    store.run(
      'INSERT INTO judge_invites (token_hash, event_id, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [hashToken(token), event.id, user.id, organizer.id, now, iso(addDays(actor.now, JUDGE_INVITE_DAYS))],
    );
    record(store, actor, {
      eventId: event.id,
      action: 'judge.invited',
      subjectType: 'user',
      subjectId: user.id,
      summary: `Invited ${user.name} <${user.email}> to judge, covering ${trackIds.length ? `${trackIds.length} track(s)` : 'every track'}.`,
    });
    return { user, token };
  });
}

export function setJudgeTracks(store: Store, actor: Actor, event: EventRow, judgeId: string, body: Body): void {
  requireOrganizer(store, actor, event, `change a judge's tracks in ${event.name}`);
  const form = new FormReader(body);
  const trackIds = readTrackIds(form, event, store);
  form.assertValid();
  store.tx(() => {
    if (!rolesIn(store, judgeId, event.id).has('judge')) throw notFound('No such judge.');
    replaceTracks(store, event.id, judgeId, trackIds);
    record(store, actor, { eventId: event.id, action: 'judge.tracks_changed', subjectType: 'user', subjectId: judgeId, summary: `Set ${judgeId} to cover ${trackIds.length ? trackIds.join(', ') : 'every track'}.` });
  });
}

/** Removes a judge who has not submitted anything. Submitted reviews are evidence and are never deleted. */
export function removeJudge(store: Store, actor: Actor, event: EventRow, judgeId: string): void {
  requireOrganizer(store, actor, event, `remove a judge from ${event.name}`);
  store.tx(() => {
    if (!rolesIn(store, judgeId, event.id).has('judge')) throw notFound('No such judge.');
    const submitted = store.get<{ n: number }>(
      `SELECT count(*) AS n FROM assignments a JOIN reviews r ON r.assignment_id = a.id
       WHERE a.event_id = ? AND a.judge_id = ? AND r.status = 'submitted'`,
      [event.id, judgeId],
    )?.n ?? 0;
    if (submitted > 0) throw conflict(`This judge has ${submitted} submitted review(s), which stay on record. Unassign their open work instead.`);
    const removed = store.run('DELETE FROM assignments WHERE event_id = ? AND judge_id = ?', [event.id, judgeId]).changes;
    store.run('DELETE FROM judge_invites WHERE event_id = ? AND user_id = ?', [event.id, judgeId]);
    store.run("DELETE FROM event_roles WHERE event_id = ? AND user_id = ? AND role = 'judge'", [event.id, judgeId]);
    record(store, actor, { eventId: event.id, action: 'judge.removed', subjectType: 'user', subjectId: judgeId, summary: `Removed judge ${judgeId} and ${removed} unfinished assignment(s).` });
  });
}

export interface JudgeInviteView {
  event: EventRow;
  user: UserRow;
  tokenHash: string;
}

export function findJudgeInvite(store: Store, token: string, now: Date): JudgeInviteView | null {
  const invite = store.get<{ token_hash: string; event_id: string; user_id: string }>(
    'SELECT token_hash, event_id, user_id FROM judge_invites WHERE token_hash = ? AND expires_at > ? AND accepted_at IS NULL',
    [hashToken(token), iso(now)],
  );
  if (!invite) return null;
  const user = store.get<UserRow>('SELECT * FROM users WHERE id = ?', [invite.user_id]);
  if (!user || !rolesIn(store, user.id, invite.event_id).has('judge')) return null;
  return { event: getEvent(store, invite.event_id), user, tokenHash: invite.token_hash };
}

/** A new judge claims the invite by choosing a password. Returns the account to sign in. */
export async function claimJudgeInvite(store: Store, actor: Actor, token: string, password: string): Promise<UserRow> {
  const problem = passwordProblem(password);
  if (problem) throw new ValidationError({ password: problem });
  const passwordHash = await hashPassword(password);
  return store.tx(() => {
    const invite = findJudgeInvite(store, token, actor.now);
    if (!invite) throw conflict('This invite has expired or has already been used. Ask the organizer for a new one.');
    if (invite.user.password_hash) throw conflict('This account already has a password. Sign in, then open the invite again.');
    store.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, invite.user.id]);
    store.run('UPDATE judge_invites SET accepted_at = ? WHERE token_hash = ?', [iso(actor.now), invite.tokenHash]);
    record(store, { ...actor, user: invite.user }, { eventId: invite.event.id, action: 'judge.accepted', subjectType: 'user', subjectId: invite.user.id, summary: `${invite.user.name} accepted the invitation to judge.` });
    return { ...invite.user, password_hash: passwordHash };
  });
}

/** An existing account accepts the invite while signed in as the invited person. */
export function acceptJudgeInvite(store: Store, actor: Actor, token: string): EventRow {
  const user = requireUser(actor);
  return store.tx(() => {
    const invite = findJudgeInvite(store, token, actor.now);
    if (!invite) throw conflict('This invite has expired or has already been used. Ask the organizer for a new one.');
    if (invite.user.id !== user.id) throw conflict(`This invite is for ${invite.user.email}. Sign in as that person to accept it.`);
    store.run('UPDATE judge_invites SET accepted_at = ? WHERE token_hash = ?', [iso(actor.now), invite.tokenHash]);
    record(store, actor, { eventId: invite.event.id, action: 'judge.accepted', subjectType: 'user', subjectId: user.id, summary: `${user.name} accepted the invitation to judge.` });
    return invite.event;
  });
}

