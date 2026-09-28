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

/**
 * Saves an edit, and submits if asked. `version` is the version the editor loaded; if a
 * teammate saved in between, the edit is refused rather than silently overwriting theirs.
 */
export function updateProject(store: Store, actor: Actor, projectId: string, body: Body): ProjectRow {
  return store.tx(() => {
    const project = getProject(store, projectId);
    const event = getEvent(store, project.event_id);
    assertSubmissionsOpen(event, actor.now);
    const user = assertTeamMember(store, actor, project, 'edit');
    if (project.status === 'withdrawn' || project.superseded_by) throw conflict('This project was withdrawn or replaced, so it can no longer be edited.');

    const form = new FormReader(body);
    const expected = form.raw('version');
    if (expected && Number(expected) !== project.version) {
      throw conflict('A teammate saved this project while you were editing. Reload to see their changes, then apply yours again.');
    }
    const tracks = listTracks(store, event.id);
    const fields = readFields(form, tracks);
    const submit = form.raw('intent') === 'submit' || project.status === 'submitted';
    if (submit) for (const [field, message] of Object.entries(submissionProblems(fields, tracks))) form.fail(field, message);
    form.assertValid();

    const becameSubmitted = submit && project.status === 'draft';
    const now = iso(actor.now);
    const next: ProjectRow = {
      ...project,
      ...fields,
      status: submit ? 'submitted' : project.status,
      submitted_at: becameSubmitted ? now : project.submitted_at,
      version: project.version + 1,
      updated_at: now,
    };
    store.run(
      `UPDATE projects SET title = ?, summary = ?, description = ?, track_id = ?, repo_url = ?, demo_url = ?, video_url = ?,
         status = ?, submitted_at = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
      [next.title, next.summary, next.description, next.track_id, next.repo_url, next.demo_url, next.video_url,
        next.status, next.submitted_at, next.version, now, project.id, project.version],
    );
    addRevision(store, actor, next, becameSubmitted ? 'submitted' : 'edited');
    const changed = EDITABLE.filter((key) => project[key] !== next[key]);
    record(store, actor, {
      eventId: event.id,
      action: becameSubmitted ? 'project.submitted' : 'project.edited',
      subjectType: 'project',
      subjectId: project.id,
      summary: becameSubmitted
        ? `${user.name} submitted “${next.title}”.`
        : `${user.name} edited ${changed.length ? changed.join(', ').replaceAll('_', ' ') : 'nothing'} of “${next.title}”.`,
    });
    return next;
  });
}

export function withdrawProject(store: Store, actor: Actor, projectId: string): void {
  store.tx(() => {
    const project = getProject(store, projectId);
    const event = getEvent(store, project.event_id);
    assertSubmissionsOpen(event, actor.now);
    const user = assertTeamMember(store, actor, project, 'withdraw');
    if (project.status === 'withdrawn') return;
    const next = { ...project, status: 'withdrawn' as const, version: project.version + 1 };
    store.run("UPDATE projects SET status = 'withdrawn', version = ?, updated_at = ? WHERE id = ?", [next.version, iso(actor.now), project.id]);
    addRevision(store, actor, next, 'withdrawn');
    record(store, actor, { eventId: event.id, action: 'project.withdrawn', subjectType: 'project', subjectId: project.id, summary: `${user.name} withdrew “${project.title}”.` });
  });
}

// Viewing ---------------------------------------------------------------------------

export interface ProjectPage {
  project: ProjectRow;
  event: EventRow;
  team: TeamRow;
  track: TrackRow | null;
  members: MemberRow[];
  canEdit: boolean;
  isOrganizer: boolean;
  supersededBy: ProjectRow | null;
  supersedes: ProjectRow[];
}

/**
 * Submitted projects are public. Drafts, withdrawn projects and replaced duplicates are
 * visible only to the team and the organizers; to anyone else they do not exist (404).
 */
export function projectPage(store: Store, actor: Actor, projectId: string): ProjectPage {
  const project = store.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) throw notFound('No such project.');
  const event = getEvent(store, project.event_id);
  const roles = actor.user ? rolesIn(store, actor.user.id, event.id) : new Set();
  const member = actor.user ? isMember(store, actor.user.id, project.team_id) : false;
  const isOrganizer = roles.has('organizer');
  const isPublic = project.status === 'submitted' && !project.superseded_by;
  if (!isPublic && !member && !isOrganizer) throw notFound('No such project.');

  const team = store.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [project.team_id]) as TeamRow;
  const track = project.track_id ? (store.get<TrackRow>('SELECT * FROM tracks WHERE id = ?', [project.track_id]) ?? null) : null;
  return {
    project,
    event,
    team,
    track,
    members: teamMembers(store, team.id),
    canEdit: member && project.status !== 'withdrawn' && !project.superseded_by && submissionsOpen(event, actor.now),
    isOrganizer,
    supersededBy: project.superseded_by ? getProject(store, project.superseded_by) : null,
    supersedes: store.all<ProjectRow>('SELECT * FROM projects WHERE superseded_by = ? ORDER BY submitted_at', [project.id]),
  };
}

export interface RevisionRow {
  version: number;
  action: string;
  snapshot: string;
  at: string;
  actor_name: string | null;
}

export function projectRevisions(store: Store, projectId: string): RevisionRow[] {
  return store.all<RevisionRow>(
    `SELECT r.version, r.action, r.snapshot, r.at, u.name AS actor_name FROM project_revisions r
     LEFT JOIN users u ON u.id = r.actor_id WHERE r.project_id = ? ORDER BY r.version DESC`,
    [projectId],
  );
}

// Gallery ---------------------------------------------------------------------------

export interface GalleryQuery {
  q?: string;
  event?: string;
  track?: string;
  sort?: 'newest' | 'oldest' | 'title';
  page?: number;
}

export interface GalleryItem extends ProjectRow {
  team_name: string;
  track_name: string | null;
  event_name: string;
  event_slug: string;
  rank: number | null;
}

export const GALLERY_PAGE_SIZE = 60;

/** The public gallery: submitted, current projects only. Filters are plain query parameters so a view can be shared by URL. */
export function gallery(store: Store, query: GalleryQuery): { items: GalleryItem[]; total: number; page: number; pages: number } {
  const clauses = ["p.status = 'submitted'", 'p.superseded_by IS NULL'];
  const params: Record<string, string | number> = {};
  if (query.event) {
    clauses.push('(e.slug = $event OR e.id = $event)');
    params.event = query.event;
  }
  if (query.track) {
    clauses.push('p.track_id = $track');
    params.track = query.track;
  }
  const q = query.q?.trim();
  if (q) {
    clauses.push("(p.title LIKE $q ESCAPE '\\' OR p.summary LIKE $q ESCAPE '\\' OR t.name LIKE $q ESCAPE '\\')");
    params.q = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  }
  const where = clauses.join(' AND ');
  const from = `FROM projects p JOIN teams t ON t.id = p.team_id JOIN events e ON e.id = p.event_id
    LEFT JOIN tracks tr ON tr.id = p.track_id
    LEFT JOIN result_snapshots s ON s.event_id = e.id AND s.superseded_at IS NULL AND e.results_published_at IS NOT NULL
    LEFT JOIN result_rows rr ON rr.snapshot_id = s.id AND rr.project_id = p.id`;
  const order = {
    newest: 'p.submitted_at DESC, p.title',
    oldest: 'p.submitted_at ASC, p.title',
    title: 'p.title COLLATE NOCASE, p.submitted_at',
  }[query.sort ?? 'oldest'];
  const total = store.get<{ n: number }>(`SELECT count(*) AS n ${from} WHERE ${where}`, params)?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  const items = store.all<GalleryItem>(
    `SELECT p.*, t.name AS team_name, tr.name AS track_name, e.name AS event_name, e.slug AS event_slug, rr.rank AS rank
     ${from} WHERE ${where} ORDER BY ${order} LIMIT $limit OFFSET $offset`,
    { ...params, limit: GALLERY_PAGE_SIZE, offset: (page - 1) * GALLERY_PAGE_SIZE },
  );
  return { items, total, page, pages };
}

// Duplicates ------------------------------------------------------------------------

export interface TeamSubmissions {
  team: TeamRow;
  projects: ProjectRow[];
}

/** Teams with more than one submission on record, for the organizer's duplicates panel. */
export function duplicateGroups(store: Store, eventId: string): TeamSubmissions[] {
  const teams = store.all<TeamRow>(
    `SELECT t.* FROM teams t WHERE t.event_id = ? AND
       (SELECT count(*) FROM projects p WHERE p.team_id = t.id AND p.status <> 'draft') > 1 ORDER BY t.name`,
    [eventId],
  );
  return teams.map((team) => ({
    team,
    projects: store.all<ProjectRow>("SELECT * FROM projects WHERE team_id = ? AND status <> 'draft' ORDER BY submitted_at", [team.id]),
  }));
}

/**
 * The organizer decides which of a team's submissions is the one that counts. The others
 * are marked as replaced by it; nothing is deleted, and the decision is audited.
 */
export function chooseLiveSubmission(store: Store, actor: Actor, event: EventRow, projectId: string): void {
  requireOrganizer(store, actor, event, `change which submission counts in ${event.name}`);
  store.tx(() => {
    const chosen = getProject(store, projectId);
    if (chosen.event_id !== event.id) throw notFound('No such project.');
    if (chosen.status !== 'submitted') throw conflict('Only a submitted project can be the one that counts.');
    if (!chosen.superseded_by) return;
    const siblings = store.all<ProjectRow>("SELECT * FROM projects WHERE team_id = ? AND id <> ? AND status <> 'draft'", [chosen.team_id, chosen.id]);
    // Retire the others first, so the one-live-project-per-team index is never violated mid-way.
    for (const sibling of siblings) {
      if (sibling.superseded_by !== chosen.id) {
        store.run('UPDATE projects SET superseded_by = ?, version = version + 1 WHERE id = ?', [chosen.id, sibling.id]);
        addRevision(store, actor, { ...sibling, superseded_by: chosen.id, version: sibling.version + 1 }, 'superseded');
      }
    }
    store.run('UPDATE projects SET superseded_by = NULL, version = version + 1 WHERE id = ?', [chosen.id]);
    addRevision(store, actor, { ...chosen, superseded_by: null, version: chosen.version + 1 }, 'restored');
    record(store, actor, {
      eventId: event.id,
      action: 'project.duplicate_resolved',
      subjectType: 'project',
      subjectId: chosen.id,
      summary: `Made ${chosen.id} “${chosen.title}” the submission that counts for its team; ${siblings.map((s) => s.id).join(', ')} now count as replaced.`,
    });
  });
}

/** Every project in an event, drafts and replaced ones included, for organizers. */
export function eventProjects(store: Store, eventId: string): (ProjectRow & { team_name: string; track_name: string | null; reviews: number; assigned: number })[] {
  return store.all(
    `SELECT p.*, t.name AS team_name, tr.name AS track_name,
       (SELECT count(*) FROM assignments a JOIN reviews r ON r.assignment_id = a.id WHERE a.project_id = p.id AND r.status = 'submitted') AS reviews,
       (SELECT count(*) FROM assignments a WHERE a.project_id = p.id) AS assigned
     FROM projects p JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id
     WHERE p.event_id = ? ORDER BY p.status = 'submitted' DESC, p.submitted_at, p.title`,
    [eventId],
  );
}
