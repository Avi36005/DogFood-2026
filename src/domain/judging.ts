import type { Store } from '../db/store.ts';
import { conflict, notFound, ValidationError } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { hashToken, newId, newToken } from '../util/tokens.ts';
import { addDays, iso } from '../util/time.ts';
import { AccessDenied, actsAsOrganizer, adminOverride, grantRole, requireOrganizer, requireRole, requireUser, rolesIn } from './access.ts';
import { ensureUser, findUserByEmail } from './accounts.ts';
import { actorLabel, record } from './audit.ts';
import { commitMethodIfFirst } from './commitment.ts';
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

export const MAX_IMPORT_ROWS = 500;

/**
 * Bulk import (T4): many judges at once from CSV lines "name,email,tracks", where tracks are
 * track names or ids separated by ";" (empty = every track). A header line is skipped. Every
 * row goes through inviteJudge, with its rules, and the whole import is one transaction: one bad
 * line and nothing is imported, and the error names every bad line.
 */
export function importJudges(store: Store, actor: Actor, event: EventRow, body: Body): { name: string; email: string; token: string }[] {
  requireOrganizer(store, actor, event, `import judges into ${event.name}`);
  const text = typeof body.csv === 'string' ? body.csv : '';
  const lines = text.split(/\r?\n/).map((line, i) => ({ line: i + 1, cells: line.split(',').map((c) => c.trim()) })).filter((l) => l.cells.some(Boolean));
  if (lines[0] && /^name$/i.test(lines[0].cells[0] ?? '')) lines.shift();
  if (!lines.length) throw new ValidationError({ csv: 'Paste at least one line: name,email,tracks.' });
  if (lines.length > MAX_IMPORT_ROWS) throw new ValidationError({ csv: `At most ${MAX_IMPORT_ROWS} judges at a time.` });
  const tracks = listTracks(store, event.id);
  const trackId = (ref: string) => tracks.find((t) => t.id === ref || t.name.toLowerCase() === ref.toLowerCase())?.id;
  const problems: string[] = [];
  const invited: { name: string; email: string; token: string }[] = [];
  const seen = new Set<string>();
  try {
    store.tx(() => {
      for (const { line, cells } of lines) {
        const [name = '', email = '', trackList = ''] = cells;
        if (cells.length > 3) { problems.push(`line ${line}: expected name,email,tracks (use ";" between tracks)`); continue; }
        if (seen.has(email.toLowerCase())) { problems.push(`line ${line}: ${email} appears twice`); continue; }
        seen.add(email.toLowerCase());
        const refs = trackList.split(';').map((t) => t.trim()).filter(Boolean);
        const ids = refs.map(trackId);
        const missing = refs.filter((_, i) => !ids[i]);
        if (missing.length) { problems.push(`line ${line}: no track called ${missing.join(', ')}`); continue; }
        try {
          const { user, token } = inviteJudge(store, actor, event, { name, email, track_ids: ids as string[] });
          invited.push({ name: user.name, email: user.email, token });
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          problems.push(`line ${line}: ${Object.values(error.fields).join(' ')}`);
        }
      }
      if (problems.length) throw new ValidationError({ csv: problems.slice(0, 20).join('\n') });
      record(store, actor, { eventId: event.id, action: 'judge.bulk_imported', summary: `${actorLabel(actor)} imported ${invited.length} judge(s) from CSV.` });
    });
  } catch (error) {
    if (error instanceof ValidationError) throw new ValidationError({ csv: `Nothing was imported. ${error.fields.csv ?? Object.values(error.fields).join(' ')}` });
    throw error;
  }
  return invited;
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

// Assignments -------------------------------------------------------------------------

export interface AssignmentView extends AssignmentRow {
  project_title: string;
  project_status: string;
  superseded_by: string | null;
  track_id: string | null;
  judge_name: string;
  review_status: 'draft' | 'submitted' | null;
}

export function listAssignments(store: Store, eventId: string): AssignmentView[] {
  return store.all<AssignmentView>(
    `SELECT a.*, p.title AS project_title, p.status AS project_status, p.superseded_by, p.track_id, u.name AS judge_name, r.status AS review_status
     FROM assignments a JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.judge_id
     LEFT JOIN reviews r ON r.assignment_id = a.id
     WHERE a.event_id = ? ORDER BY p.title, u.name`,
    [eventId],
  );
}

/** Judges who are on a project's team: always a conflict, whatever the role table says. */
function conflictedJudges(store: Store, projectId: string): Set<string> {
  return new Set(
    store
      .all<{ user_id: string }>('SELECT m.user_id FROM team_members m JOIN projects p ON p.team_id = m.team_id WHERE p.id = ?', [projectId])
      .map((row) => row.user_id),
  );
}

function rankableProjects(store: Store, eventId: string): ProjectRow[] {
  return store.all<ProjectRow>(
    "SELECT * FROM projects WHERE event_id = ? AND status = 'submitted' AND superseded_by IS NULL ORDER BY id",
    [eventId],
  );
}

export function autoAssign(store: Store, actor: Actor, event: EventRow, options: { maxLoad?: number } = {}): { created: number; shortfalls: (Shortfall & { title: string })[] } {
  const organizer = requireOrganizer(store, actor, event, `auto-assign judges in ${event.name}`);
  return store.tx(() => {
    const projects = rankableProjects(store, event.id);
    const existing = listAssignments(store, event.id);
    const judges: PlanJudge[] = listJudges(store, event.id).map((j) => ({
      id: j.id,
      trackIds: new Set(j.trackIds),
      load: existing.filter((a) => a.judge_id === j.id).length,
    }));
    const planProjects: PlanProject[] = projects.map((p) => ({
      id: p.id,
      trackId: p.track_id,
      assignedJudges: new Set(existing.filter((a) => a.project_id === p.id).map((a) => a.judge_id)),
      conflictedJudges: conflictedJudges(store, p.id),
    }));
    const plan = planAssignments(planProjects, judges, { target: event.reviews_per_project, maxLoad: options.maxLoad, seed: event.id });
    const now = iso(actor.now);
    for (const { projectId, judgeId } of plan.assignments) {
      store.run(
        "INSERT INTO assignments (id, event_id, project_id, judge_id, source, created_by, created_at) VALUES (?, ?, ?, ?, 'auto', ?, ?)",
        [newId('asg'), event.id, projectId, judgeId, organizer.id, now],
      );
    }
    const titles = new Map(projects.map((p) => [p.id, p.title]));
    const shortfalls = plan.shortfalls.map((s) => ({ ...s, title: titles.get(s.projectId) ?? s.projectId }));
    record(store, actor, {
      eventId: event.id,
      action: 'assignment.auto',
      subjectType: 'event',
      subjectId: event.id,
      summary: `Auto-assigned ${plan.assignments.length} review slot(s) toward ${event.reviews_per_project} reviews per project; ${shortfalls.length} project(s) still short.`,
      detail: { created: plan.assignments, shortfalls: plan.shortfalls },
    });
    return { created: plan.assignments.length, shortfalls };
  });
}

export function assignManually(store: Store, actor: Actor, event: EventRow, body: Body): void {
  const organizer = requireOrganizer(store, actor, event, `assign a judge in ${event.name}`);
  const form = new FormReader(body);
  const projectId = form.text('project_id', { label: 'Project', required: true, max: 60 });
  const judgeId = form.text('judge_id', { label: 'Judge', required: true, max: 60 });
  form.assertValid();
  store.tx(() => {
    const project = store.get<ProjectRow>('SELECT * FROM projects WHERE id = ? AND event_id = ?', [projectId, event.id]);
    if (!project || project.status !== 'submitted' || project.superseded_by) throw new ValidationError({ project_id: 'Choose a submitted project from this event.' });
    if (!rolesIn(store, judgeId, event.id).has('judge')) throw new ValidationError({ judge_id: 'Choose a judge of this event.' });
    if (conflictedJudges(store, projectId).has(judgeId)) throw new ValidationError({ judge_id: 'This judge is on the project’s team.' });
    if (store.get('SELECT 1 FROM assignments WHERE project_id = ? AND judge_id = ?', [projectId, judgeId])) {
      throw new ValidationError({ judge_id: 'This judge already has this project.' });
    }
    const id = newId('asg');
    store.run("INSERT INTO assignments (id, event_id, project_id, judge_id, source, created_by, created_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)", [
      id, event.id, projectId, judgeId, organizer.id, iso(actor.now),
    ]);
    record(store, actor, { eventId: event.id, action: 'assignment.manual', subjectType: 'assignment', subjectId: id, summary: `Assigned “${project.title}” to judge ${judgeId}.` });
  });
}

export function unassign(store: Store, actor: Actor, event: EventRow, assignmentId: string): void {
  requireOrganizer(store, actor, event, `remove an assignment in ${event.name}`);
  store.tx(() => {
    const assignment = store.get<AssignmentRow & { review_status: string | null }>(
      'SELECT a.*, r.status AS review_status FROM assignments a LEFT JOIN reviews r ON r.assignment_id = a.id WHERE a.id = ? AND a.event_id = ?',
      [assignmentId, event.id],
    );
    if (!assignment) throw notFound('No such assignment.');
    if (assignment.review_status === 'submitted') throw conflict('This review is submitted and stays on record.');
    store.run('DELETE FROM assignments WHERE id = ?', [assignmentId]);
    record(store, actor, { eventId: event.id, action: 'assignment.removed', subjectType: 'assignment', subjectId: assignmentId, summary: `Removed the assignment of ${assignment.project_id} to ${assignment.judge_id}${assignment.review_status ? ' and its draft review' : ''}.` });
  });
}

// Reviews -----------------------------------------------------------------------------

export interface QueueItem {
  assignment_id: string;
  project_id: string;
  title: string;
  summary: string;
  team_name: string;
  track_name: string | null;
  review_status: 'draft' | 'submitted' | null;
  updated_at: string | null;
  replaced: 0 | 1;
}

/** A judge's own work in one event. The query is keyed on the caller's id; there is no parameter to ask for anyone else's. */
export function judgeQueue(store: Store, actor: Actor, event: EventRow): QueueItem[] {
  const judge = requireRole(store, actor, event, ['judge'], `open the judging queue of ${event.name}`);
  return store.all<QueueItem>(
    `SELECT a.id AS assignment_id, p.id AS project_id, p.title, p.summary, t.name AS team_name, tr.name AS track_name,
       r.status AS review_status, r.updated_at, (p.superseded_by IS NOT NULL OR p.status <> 'submitted') AS replaced
     FROM assignments a JOIN projects p ON p.id = a.project_id JOIN teams t ON t.id = p.team_id
     LEFT JOIN tracks tr ON tr.id = p.track_id LEFT JOIN reviews r ON r.assignment_id = a.id
     WHERE a.event_id = ? AND a.judge_id = ?
     ORDER BY (r.status = 'submitted'), (r.status IS NULL) DESC, p.title`,
    [event.id, judge.id],
  );
}

export interface ReviewPage {
  assignment: AssignmentRow;
  event: EventRow;
  project: ProjectRow & { team_name: string; track_name: string | null };
  criteria: CriterionRow[];
  review: ReviewRow | null;
  scores: Map<string, number>;
  isOwn: boolean;
  canEdit: boolean;
}

function scoreMap(store: Store, assignmentId: string): Map<string, number> {
  return new Map(
    store
      .all<{ criterion_id: string; value: number }>('SELECT criterion_id, value FROM review_scores WHERE assignment_id = ?', [assignmentId])
      .map((row) => [row.criterion_id, row.value]),
  );
}

/**
 * Loads a review for its judge, or read-only for an organizer of the event (or an administrator,
 * audited). Anyone else gets
 * 403 whether or not the assignment exists, so the URL cannot be used to probe for ids.
 */
export function reviewPage(store: Store, actor: Actor, assignmentId: string): ReviewPage {
  const user = requireUser(actor);
  const assignment = store.get<AssignmentRow>('SELECT * FROM assignments WHERE id = ?', [assignmentId]);
  const isOwn = assignment?.judge_id === user.id;
  const isOrganizer = assignment && !isOwn ? actsAsOrganizer(store, actor, assignment.event_id, `read another judge's review (${assignmentId})`) : false;
  if (!assignment || (!isOwn && !isOrganizer)) {
    throw new AccessDenied('This review belongs to another judge.', {
      eventId: assignment?.event_id ?? null,
      action: 'access.denied',
      subjectType: 'assignment',
      subjectId: assignmentId,
      summary: `${actorLabel(actor)} was refused a review that is not theirs (${assignmentId}).`,
    });
  }
  const event = getEvent(store, assignment.event_id);
  const project = store.get<ProjectRow & { team_name: string; track_name: string | null }>(
    `SELECT p.*, t.name AS team_name, tr.name AS track_name FROM projects p JOIN teams t ON t.id = p.team_id
     LEFT JOIN tracks tr ON tr.id = p.track_id WHERE p.id = ?`,
    [assignment.project_id],
  );
  if (!project) throw notFound('No such project.');
  const review = store.get<ReviewRow>('SELECT * FROM reviews WHERE assignment_id = ?', [assignment.id]) ?? null;
  const live = project.status === 'submitted' && !project.superseded_by;
  return {
    assignment,
    event,
    project,
    criteria: listCriteria(store, event.id),
    review,
    scores: scoreMap(store, assignment.id),
    isOwn,
    canEdit: isOwn && live && judgingOpen(event, actor.now),
  };
}

/** Saves a draft or submits. Only the assigned judge can write; organizers cannot score on anyone's behalf. */
export function saveReview(store: Store, actor: Actor, assignmentId: string, body: Body): { submitted: boolean; project: string } {
  return store.tx(() => {
    const page = reviewPage(store, actor, assignmentId);
    if (!page.isOwn) {
      throw new AccessDenied('Only the assigned judge can score this project.', {
        eventId: page.event.id,
        action: 'access.denied',
        subjectType: 'assignment',
        subjectId: assignmentId,
        summary: `${actorLabel(actor)} was refused: write a score on another judge's review of “${page.project.title}”.`,
      });
    }
    assertJudgingOpen(page.event, actor.now);
    if (page.project.status !== 'submitted' || page.project.superseded_by) throw conflict('This project was withdrawn or replaced, so it no longer takes reviews.');

    const form = new FormReader(body);
    const submit = form.raw('intent') === 'submit';
    const values = new Map<string, number>();
    for (const criterion of page.criteria) {
      const field = `score_${criterion.key}`;
      if (form.raw(field).trim() === '') {
        if (submit) form.fail(field, `Score ${criterion.name} to submit.`);
        continue;
      }
      values.set(criterion.id, form.int(field, { label: criterion.name, min: page.event.score_min, max: page.event.score_max }));
    }
    const comment = form.text('comment', { label: 'Comment', max: 5000 });
    form.assertValid();

    const now = iso(actor.now);
    const wasSubmitted = page.review?.status === 'submitted';
    // Once submitted, a review stays submitted: a later save is an edit, not a retraction.
    const status = submit || wasSubmitted ? 'submitted' : 'draft';
    if (status === 'submitted' && values.size < page.criteria.length) {
      throw new ValidationError(Object.fromEntries(page.criteria.filter((c) => !values.has(c.id)).map((c) => [`score_${c.key}`, `Score ${c.name} to submit.`])));
    }
    store.run(
      `INSERT INTO reviews (assignment_id, status, comment, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (assignment_id) DO UPDATE SET status = excluded.status, comment = excluded.comment,
         submitted_at = coalesce(reviews.submitted_at, excluded.submitted_at), updated_at = excluded.updated_at`,
      [assignmentId, status, comment, status === 'submitted' ? now : null, now],
    );
    store.run('DELETE FROM review_scores WHERE assignment_id = ?', [assignmentId]);
    for (const [criterionId, value] of values) {
      store.run('INSERT INTO review_scores (assignment_id, criterion_id, value) VALUES (?, ?, ?)', [assignmentId, criterionId, value]);
    }
    if (values.size) commitMethodIfFirst(store, actor, page.event.id);
    const verb = status === 'draft' ? 'saved a draft review of' : wasSubmitted ? 'revised their review of' : 'submitted a review of';
    record(store, actor, {
      eventId: page.event.id,
      action: status === 'draft' ? 'review.draft' : wasSubmitted ? 'review.revised' : 'review.submitted',
      subjectType: 'assignment',
      subjectId: assignmentId,
      summary: `${actor.user?.name} ${verb} “${page.project.title}”.`,
      detail: Object.fromEntries(page.criteria.map((c) => [c.key, values.get(c.id) ?? null])),
    });
    return { submitted: status === 'submitted', project: page.project.id };
  });
}

// The scores API --------------------------------------------------------------------------

export interface ScoreEntry {
  event_id: string;
  assignment_id: string;
  project_id: string;
  project_title: string;
  status: 'draft' | 'submitted';
  criteria: Record<string, number>;
  weighted: number | null;
  comment: string;
  submitted_at: string | null;
  updated_at: string;
}

export interface JudgeScores {
  judge: { id: string; name: string };
  events: { id: string; name: string }[];
  scores: ScoreEntry[];
}

function scoresOf(store: Store, judgeId: string, eventIds: string[]): ScoreEntry[] {
  const entries: ScoreEntry[] = [];
  for (const eventId of eventIds) {
    const criteria = listCriteria(store, eventId);
    const rows = store.all<{ assignment_id: string; project_id: string; project_title: string; status: 'draft' | 'submitted'; comment: string; submitted_at: string | null; updated_at: string }>(
      `SELECT a.id AS assignment_id, p.id AS project_id, p.title AS project_title, r.status, r.comment, r.submitted_at, r.updated_at
       FROM assignments a JOIN reviews r ON r.assignment_id = a.id JOIN projects p ON p.id = a.project_id
       WHERE a.event_id = ? AND a.judge_id = ? ORDER BY p.id`,
      [eventId, judgeId],
    );
    for (const row of rows) {
      const values = scoreMap(store, row.assignment_id);
      entries.push({
        event_id: eventId,
        ...row,
        criteria: Object.fromEntries(criteria.filter((c) => values.has(c.id)).map((c) => [c.key, values.get(c.id) as number])),
        weighted: weightedScore(values, criteria),
      });
    }
  }
  return entries;
}

/**
 * GET /api/judge/scores[?judge=<id>][&event=<id>]
 *
 * A judge reads their own scores. Reading anyone else's needs the organizer role in an event
 * where that person judges. The decision is made from the caller's roles before the target
 * is looked up, so a refusal says nothing about whether the other judge exists, and every
 * refusal is written to the audit trail of the caller's events.
 */
export function judgeScores(store: Store, actor: Actor, query: { judge?: string | null; event?: string | null }): JudgeScores {
  const user = requireUser(actor);
  const targetId = query.judge?.trim() || user.id;
  const eventFilter = query.event ? getEvent(store, query.event).id : null;
  const myRoles = store.all<{ event_id: string; role: string; name: string }>(
    'SELECT r.event_id, r.role, e.name FROM event_roles r JOIN events e ON e.id = r.event_id WHERE r.user_id = ?',
    [user.id],
  ).filter((row) => !eventFilter || row.event_id === eventFilter);

  const refuse = (message: string, what: string): never => {
    const eventIds = [...new Set(myRoles.map((row) => row.event_id))];
    throw new AccessDenied(message, {
      eventId: eventIds[0] ?? null,
      action: 'access.denied',
      subjectType: 'judge_scores',
      subjectId: targetId,
      summary: `${actorLabel(actor)} was refused ${what}.`,
      detail: { requested_judge: targetId, other_events: eventIds.slice(1) },
    });
  };

  let eventIds: string[];
  if (targetId === user.id) {
    eventIds = myRoles.filter((row) => row.role === 'judge').map((row) => row.event_id);
    if (eventIds.length === 0) refuse('Only judges have scores to read.', 'judge scores (they are not a judge)');
  } else {
    const organizes = myRoles.filter((row) => row.role === 'organizer').map((row) => row.event_id);
    if (user.is_admin) {
      // Administrators read any judge's scores (FIG. 02), audited in each event they do not organize.
      const judged = store
        .all<{ event_id: string }>("SELECT event_id FROM event_roles WHERE user_id = ? AND role = 'judge' ORDER BY event_id", [targetId])
        .map((row) => row.event_id)
        .filter((eventId) => !eventFilter || eventId === eventFilter);
      for (const eventId of judged) if (!organizes.includes(eventId)) adminOverride(store, actor, eventId, `read the scores of ${targetId}`);
      organizes.push(...judged.filter((eventId) => !organizes.includes(eventId)));
    }
    if (organizes.length === 0) refuse("You can read only your own scores. Another judge's scores are visible to organizers only.", `the scores of another judge (${targetId})`);
    eventIds = organizes.filter((eventId) => rolesIn(store, targetId, eventId).has('judge'));
    if (eventIds.length === 0) refuse('That person does not judge any event you organize.', `the scores of ${targetId}, who does not judge their events`);
  }

  const judge = store.get<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ?', [targetId]) as { id: string; name: string };
  const events = eventIds.map((id) => {
    const event = getEvent(store, id);
    return { id: event.id, name: event.name };
  });
  return { judge, events, scores: scoresOf(store, targetId, eventIds) };
}
