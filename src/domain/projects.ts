import type { Store } from '../db/store.ts';
import { badRequest, conflict, forbidden, notFound } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { newId } from '../util/tokens.ts';
import { iso } from '../util/time.ts';
import { AccessDenied, myEventRoles, requireOrganizer, requireUser, rolesIn } from './access.ts';
import { actorLabel, record } from './audit.ts';
import { assertSubmissionsOpen, getEvent, listTracks, submissionsOpen } from './events.ts';
import { isMember, myTeam, teamMembers, type MemberRow } from './teams.ts';
import type { Actor, EventRow, ProjectRow, TeamRow, TrackRow, UserRow } from './types.ts';

const EDITABLE = ['title', 'summary', 'description', 'track_id', 'repo_url', 'demo_url', 'video_url'] as const;
type ProjectFields = Pick<ProjectRow, (typeof EDITABLE)[number]>;

function readFields(form: FormReader, tracks: TrackRow[]): ProjectFields {
  return {
    title: form.text('title', { label: 'Title', required: true, max: 120 }),
    summary: form.text('summary', { label: 'Summary', max: 280 }),
    description: form.text('description', { label: 'Description', max: 10000 }),
    track_id: tracks.length ? form.choice('track_id', tracks.map((t) => t.id), 'track', false) : null,
    repo_url: form.url('repo_url', 'Repository URL'),
    demo_url: form.url('demo_url', 'Demo URL'),
    video_url: form.url('video_url', 'Video URL'),
  };
}

/** A draft may be incomplete; a submission may not. */
function submissionProblems(fields: ProjectFields, tracks: TrackRow[]): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!fields.summary) problems.summary = 'A one-line summary is required to submit.';
  if (tracks.length && !fields.track_id) problems.track_id = 'Choose a track to submit.';
  if (!fields.repo_url && !fields.demo_url) problems.repo_url = 'Add a repository or a demo link to submit.';
  return problems;
}

function snapshot(project: ProjectFields & { status: string }): string {
  const out: Record<string, unknown> = { status: project.status };
  for (const key of EDITABLE) out[key] = project[key];
  return JSON.stringify(out);
}

function addRevision(store: Store, actor: Actor, project: ProjectRow, action: string): void {
  store.run(
    'INSERT INTO project_revisions (project_id, version, action, snapshot, actor_id, at) VALUES (?, ?, ?, ?, ?, ?)',
    [project.id, project.version, action, snapshot(project), actor.user?.id ?? null, iso(actor.now)],
  );
}

export function getProject(store: Store, id: string): ProjectRow {
  const project = store.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
  if (!project) throw notFound('No such project.');
  return project;
}

export function liveProjectOfTeam(store: Store, teamId: string): ProjectRow | undefined {
  return store.get<ProjectRow>(
    "SELECT * FROM projects WHERE team_id = ? AND superseded_by IS NULL AND status <> 'withdrawn'",
    [teamId],
  );
}

/**
 * Works out which event a submission is for when the request does not say: the event of the
 * person's team, otherwise the only event currently accepting submissions.
 */
export function eventForSubmission(store: Store, user: UserRow, hint: string | null, now: Date): EventRow {
  if (hint) return getEvent(store, hint);
  const mine = myEventRoles(store, user.id).filter((entry) => entry.roles.has('participant'));
  if (mine.length === 1 && mine[0]) return mine[0].event;
  const open = store.all<EventRow>('SELECT * FROM events').filter((event) => submissionsOpen(event, now));
  if (mine.length === 0 && open.length === 1 && open[0]) return open[0];
  throw badRequest('Say which event this project is for, with ?event=<event id or slug>.');
}

export function createProject(store: Store, actor: Actor, event: EventRow, body: Body): ProjectRow {
  const user = requireUser(actor);
  const tracks = listTracks(store, event.id);
  return store.tx(() => {
    // The deadline is checked first, so a late request is refused for being late, whatever else is wrong with it.
    assertSubmissionsOpen(event, actor.now);
    const team = myTeam(store, user.id, event.id);
    if (!team) throw forbidden(`Create or join a team for ${event.name} before starting a project.`);
    const existing = liveProjectOfTeam(store, team.id);
    if (existing) throw conflict(`${team.name} already has a project, “${existing.title}”. Edit that one instead.`);

    const form = new FormReader(body);
    const fields = readFields(form, tracks);
    const submit = form.raw('intent') === 'submit';
    if (submit) for (const [field, message] of Object.entries(submissionProblems(fields, tracks))) form.fail(field, message);
    form.assertValid();

    const now = iso(actor.now);
    const project: ProjectRow = {
      id: newId('prj'),
      event_id: event.id,
      team_id: team.id,
      ...fields,
      status: submit ? 'submitted' : 'draft',
      submitted_at: submit ? now : null,
      superseded_by: null,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    store.run(
      `INSERT INTO projects (id, event_id, team_id, track_id, title, summary, description, repo_url, demo_url, video_url,
         status, submitted_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [project.id, event.id, team.id, fields.track_id, fields.title, fields.summary, fields.description, fields.repo_url,
        fields.demo_url, fields.video_url, project.status, project.submitted_at, now, now],
    );
    addRevision(store, actor, project, submit ? 'submitted' : 'created');
    record(store, actor, {
      eventId: event.id,
      action: submit ? 'project.submitted' : 'project.created',
      subjectType: 'project',
      subjectId: project.id,
      summary: `${user.name} ${submit ? 'submitted' : 'started a draft of'} “${project.title}” for ${team.name}.`,
    });
    return project;
  });
}

function assertTeamMember(store: Store, actor: Actor, project: ProjectRow, attempted: string): UserRow {
  const user = requireUser(actor);
  if (isMember(store, user.id, project.team_id)) return user;
  throw new AccessDenied('Only members of the team can change this project.', {
    eventId: project.event_id,
    action: 'access.denied',
    subjectType: 'project',
    subjectId: project.id,
    summary: `${actorLabel(actor)} was refused: ${attempted} “${project.title}”.`,
  });
}

