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

