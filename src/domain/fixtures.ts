import { createHash } from 'node:crypto';
import type { Store } from '../db/store.ts';
import { slugify } from '../util/form.ts';
import { iso, parseInstant } from '../util/time.ts';
import { grantRole } from './access.ts';
import { record } from './audit.ts';
import { DEFAULT_CRITERIA } from './events.ts';
import type { Actor } from './types.ts';

/**
 * Imports the DOGFOOD fixtures.json format: { event, tracks, judges, teams, projects, scores }.
 *
 * The whole file is validated before anything is written, and the write is one transaction,
 * so a bad file changes nothing. Importing the same event twice is a no-op. Fixture ids are
 * kept as primary keys so every exported number traces back to a line of the input.
 */

interface FixtureEvent { id: string; name: string; submissions_close: string }
interface FixtureTrack { id: string; name: string }
interface FixtureJudge { id: string; name: string; email: string; tracks: string[] }
interface FixtureTeam { id: string; name: string; members: string[] }
interface FixtureProject { id: string; team: string; track: string; title: string; summary: string; repo_url: string; submitted_at: string }
interface FixtureScore { judge: string; project: string; criteria: Record<string, number>; comment: string }

export interface Fixture {
  event: FixtureEvent;
  tracks: FixtureTrack[];
  judges: FixtureJudge[];
  teams: FixtureTeam[];
  projects: FixtureProject[];
  scores: FixtureScore[];
}

export interface ImportReport {
  eventId: string;
  skipped: boolean;
  counts: Record<string, number>;
  duplicates: { team: string; kept: string; replaced: string[] }[];
  warnings: string[];
}

export class FixtureError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`fixtures.json was not imported:\n  - ${problems.slice(0, 20).join('\n  - ')}${problems.length > 20 ? `\n  - …and ${problems.length - 20} more` : ''}`);
    this.problems = problems;
  }
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks shape and every cross-reference. Returns the typed fixture or throws with every problem found. */
export function validateFixture(data: unknown): { fixture: Fixture; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isObject(data)) throw new FixtureError(['the file is not a JSON object']);

  const list = <T>(key: string, check: (item: Record<string, unknown>, at: string) => boolean): T[] => {
    const value = data[key];
    if (!Array.isArray(value)) {
      problems.push(`"${key}" must be an array`);
      return [];
    }
    return value.filter((item, i) => {
      const at = `${key}[${i}]`;
      if (!isObject(item)) {
        problems.push(`${at} is not an object`);
        return false;
      }
      return check(item, at);
    }) as T[];
  };
  const need = (item: Record<string, unknown>, at: string, ...keys: string[]) => {
    const missing = keys.filter((k) => !isString(item[k]));
    for (const k of missing) problems.push(`${at}.${k} must be a non-empty string`);
    return missing.length === 0;
  };
  const unique = (items: { id: string }[], what: string) => {
    const seen = new Set<string>();
    for (const { id } of items) {
      if (seen.has(id)) problems.push(`${what} id ${id} appears twice`);
      seen.add(id);
    }
    return seen;
  };
  const instant = (value: string, at: string) => {
    try {
      parseInstant(value);
    } catch {
      problems.push(`${at} is not an ISO 8601 timestamp: ${value}`);
    }
  };

  const event = data.event;
  if (!isObject(event) || !need(event, 'event', 'id', 'name', 'submissions_close')) {
    if (!isObject(event)) problems.push('"event" must be an object');
  } else {
    instant(event.submissions_close as string, 'event.submissions_close');
  }

  const tracks = list<FixtureTrack>('tracks', (t, at) => need(t, at, 'id', 'name'));
  const judges = list<FixtureJudge>('judges', (j, at) => {
    const ok = need(j, at, 'id', 'name', 'email');
    if (!Array.isArray(j.tracks) || !j.tracks.every(isString)) problems.push(`${at}.tracks must be an array of track ids`);
    if (ok && !EMAIL.test(j.email as string)) problems.push(`${at}.email is not an email address`);
    return ok && Array.isArray(j.tracks);
  });
  const teams = list<FixtureTeam>('teams', (t, at) => {
    const ok = need(t, at, 'id', 'name');
    if (!Array.isArray(t.members) || t.members.length === 0 || !t.members.every((m) => isString(m) && EMAIL.test(m))) {
      problems.push(`${at}.members must be a non-empty array of email addresses`);
      return false;
    }
    return ok;
  });
  const projects = list<FixtureProject>('projects', (p, at) => {
    const ok = need(p, at, 'id', 'team', 'track', 'title', 'submitted_at');
    if (ok) instant(p.submitted_at as string, `${at}.submitted_at`);
    for (const k of ['summary', 'repo_url'] as const) if (p[k] !== undefined && typeof p[k] !== 'string') problems.push(`${at}.${k} must be a string`);
    return ok;
  });
  const scores = list<FixtureScore>('scores', (s, at) => {
    const ok = need(s, at, 'judge', 'project');
    if (!isObject(s.criteria) || Object.keys(s.criteria).length === 0) {
      problems.push(`${at}.criteria must be an object of criterion: integer`);
      return false;
    }
    for (const [key, value] of Object.entries(s.criteria)) {
      if (!/^[a-z0-9_]+$/.test(key)) problems.push(`${at}.criteria has an invalid key "${key}"`);
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) problems.push(`${at}.criteria.${key} must be an integer from 1 to 5, got ${String(value)}`);
    }
    if (s.comment !== undefined && typeof s.comment !== 'string') problems.push(`${at}.comment must be a string`);
    return ok;
  });

  const trackIds = unique(tracks, 'track');
  const judgeIds = unique(judges, 'judge');
  const teamIds = unique(teams, 'team');
  const projectIds = unique(projects, 'project');
  const judgeTracks = new Map(judges.map((j) => [j.id, new Set(j.tracks)]));
  for (const j of judges) for (const t of j.tracks) if (!trackIds.has(t)) problems.push(`judge ${j.id} covers unknown track ${t}`);

  const teamNames = new Map<string, string[]>();
  for (const team of teams) teamNames.set(team.name.toLowerCase(), [...(teamNames.get(team.name.toLowerCase()) ?? []), team.id]);
  for (const ids of teamNames.values()) {
    if (ids.length > 1) warnings.push(`teams ${ids.join(', ')} share a name; they have different members, so they are kept as separate teams`);
  }

  const memberOf = new Map<string, string>();
  for (const team of teams) {
    for (const email of team.members) {
      const key = email.toLowerCase();
      const other = memberOf.get(key);
      if (other && other !== team.id) problems.push(`${email} is on both ${other} and ${team.id}`);
      memberOf.set(key, team.id);
    }
  }
  for (const j of judges) if (memberOf.has(j.email.toLowerCase())) problems.push(`judge ${j.id} (${j.email}) is also on team ${memberOf.get(j.email.toLowerCase())}`);

  const projectTrack = new Map<string, string>();
  for (const p of projects) {
    if (!teamIds.has(p.team)) problems.push(`project ${p.id} names unknown team ${p.team}`);
    if (!trackIds.has(p.track)) problems.push(`project ${p.id} names unknown track ${p.track}`);
    projectTrack.set(p.id, p.track);
    if (isObject(event) && isString(event.submissions_close) && p.submitted_at > event.submissions_close) {
      warnings.push(`project ${p.id} was submitted after the deadline (${p.submitted_at})`);
    }
  }
  const pairs = new Set<string>();
  const keySets = new Set<string>();
  for (const s of scores) {
    if (!judgeIds.has(s.judge)) problems.push(`a score names unknown judge ${s.judge}`);
    if (!projectIds.has(s.project)) problems.push(`a score names unknown project ${s.project}`);
    const pair = `${s.judge}/${s.project}`;
    if (pairs.has(pair)) problems.push(`judge ${s.judge} scored ${s.project} twice`);
    pairs.add(pair);
    keySets.add(Object.keys(s.criteria).sort().join(','));
    const track = projectTrack.get(s.project);
    const covered = judgeTracks.get(s.judge);
    if (track && covered && covered.size > 0 && !covered.has(track)) warnings.push(`judge ${s.judge} scored ${s.project} outside their tracks`);
  }
  if (keySets.size > 1) problems.push(`scores use different criteria sets: ${[...keySets].join(' | ')}`);

  if (problems.length) throw new FixtureError(problems);
  const fixture: Fixture = { event: event as unknown as FixtureEvent, tracks, judges, teams, projects, scores };
  return { fixture, warnings };
}

const personId = (email: string) => `usr_${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12)}`;
const title = (key: string) => key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function importFixtures(store: Store, actor: Actor, data: unknown): ImportReport {
  const { fixture, warnings } = validateFixture(data);
  const { event } = fixture;
  const counts: Record<string, number> = {};
  const report: ImportReport = { eventId: event.id, skipped: false, counts, duplicates: [], warnings };
  if (store.get('SELECT 1 FROM events WHERE id = ?', [event.id])) return { ...report, skipped: true };

  const now = iso(actor.now);
  const close = parseInstant(event.submissions_close).toISOString();
  store.tx(() => {
    let slug = slugify(event.name) || event.id.toLowerCase();
    for (let n = 2; store.get('SELECT 1 FROM events WHERE slug = ?', [slug]); n++) slug = `${slugify(event.name)}-${n}`;
    store.run(
      `INSERT INTO events (id, slug, name, tagline, description, submissions_close_at, reviews_per_project, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 3, 'fixture', ?, ?)`,
      [event.id, slug, event.name, 'Imported from the DOGFOOD fixtures.', 'Every project, judge and score on this event was loaded from fixtures.json at first boot.', close, now, now],
    );

    fixture.tracks.forEach((t, position) => {
      store.run('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, ?)', [t.id, event.id, t.name, position]);
    });
    counts.tracks = fixture.tracks.length;

    // The rubric is whatever criteria the scores use, equally weighted; the file gives no weights.
    const criterionKeys = [...new Set(fixture.scores.flatMap((s) => Object.keys(s.criteria)))];
    const criterionIds = new Map<string, string>();
    criterionKeys.forEach((key, position) => {
      const id = `crt_${event.id}_${key}`;
      criterionIds.set(key, id);
      const known = DEFAULT_CRITERIA.find((c) => c.key === key);
      store.run('INSERT INTO criteria (id, event_id, key, name, description, weight, position) VALUES (?, ?, ?, ?, ?, 1, ?)', [
        id, event.id, key, known?.name ?? title(key), known?.description ?? '', position,
      ]);
    });
    counts.criteria = criterionKeys.length;

    const userIdByEmail = new Map<string, string>();
    const upsertUser = (id: string, email: string, name: string) => {
      const existing = store.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
      if (existing) return existing.id;
      store.run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [id, email.toLowerCase(), name, now]);
      return id;
    };

    for (const judge of fixture.judges) {
      const userId = upsertUser(judge.id, judge.email, judge.name);
      userIdByEmail.set(judge.email.toLowerCase(), userId);
      grantRole(store, event.id, userId, 'judge', null, now);
      for (const trackId of judge.tracks) {
        store.run('INSERT INTO judge_tracks (event_id, judge_id, track_id) VALUES (?, ?, ?)', [event.id, userId, trackId]);
      }
    }
    counts.judges = fixture.judges.length;

    let members = 0;
    for (const team of fixture.teams) {
      store.run('INSERT INTO teams (id, event_id, name, created_at) VALUES (?, ?, ?, ?)', [team.id, event.id, team.name, now]);
      team.members.forEach((email, index) => {
        const userId = upsertUser(personId(email), email, email.split('@')[0] ?? email);
        store.run('INSERT INTO team_members (team_id, event_id, user_id, is_captain, joined_at) VALUES (?, ?, ?, ?, ?)', [team.id, event.id, userId, index === 0 ? 1 : 0, now]);
        grantRole(store, event.id, userId, 'participant', null, now);
        members++;
      });
    }
    counts.teams = fixture.teams.length;
    counts.people = members;

    // Duplicate policy: one live project per team. The latest submission counts; earlier ones are
    // kept, marked as replaced by it, and listed for the organizer, who can reverse the choice.
    const byTeam = new Map<string, FixtureProject[]>();
    for (const p of fixture.projects) byTeam.set(p.team, [...(byTeam.get(p.team) ?? []), p]);
    const supersededBy = new Map<string, string>();
    for (const [teamId, list] of byTeam) {
      if (list.length < 2) continue;
      const ordered = [...list].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id.localeCompare(b.id));
      const kept = ordered.at(-1) as FixtureProject;
      const replaced = ordered.slice(0, -1);
      for (const p of replaced) supersededBy.set(p.id, kept.id);
      report.duplicates.push({ team: teamId, kept: kept.id, replaced: replaced.map((p) => p.id) });
    }

    for (const p of fixture.projects) {
      const submittedAt = parseInstant(p.submitted_at).toISOString();
      store.run(
        `INSERT INTO projects (id, event_id, team_id, track_id, title, summary, repo_url, status, submitted_at, superseded_by, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 1, ?, ?)`,
        [p.id, event.id, p.team, p.track, p.title, p.summary ?? '', p.repo_url ?? '', submittedAt, supersededBy.get(p.id) ?? null, submittedAt, submittedAt],
      );
      store.run(
        "INSERT INTO project_revisions (project_id, version, action, snapshot, actor_id, at) VALUES (?, 1, 'imported', ?, NULL, ?)",
        [p.id, JSON.stringify({ status: 'submitted', title: p.title, summary: p.summary ?? '', track_id: p.track, repo_url: p.repo_url ?? '' }), now],
      );
    }
    counts.projects = fixture.projects.length;

    // Each score becomes an assignment plus a submitted review. The file has no review times,
    // so reviews are stamped with the import time.
    fixture.scores.forEach((s, index) => {
      const judgeId = userIdByEmail.get(fixture.judges.find((j) => j.id === s.judge)?.email.toLowerCase() ?? '') ?? s.judge;
      const assignmentId = `asg_${event.id}_${String(index + 1).padStart(4, '0')}`;
      store.run(
        "INSERT INTO assignments (id, event_id, project_id, judge_id, source, created_at) VALUES (?, ?, ?, ?, 'fixture', ?)",
        [assignmentId, event.id, s.project, judgeId, now],
      );
      store.run("INSERT INTO reviews (assignment_id, status, comment, submitted_at, updated_at) VALUES (?, 'submitted', ?, ?, ?)", [assignmentId, s.comment ?? '', now, now]);
      for (const [key, value] of Object.entries(s.criteria)) {
        store.run('INSERT INTO review_scores (assignment_id, criterion_id, value) VALUES (?, ?, ?)', [assignmentId, criterionIds.get(key) as string, value]);
      }
    });
    counts.scores = fixture.scores.length;

    record(store, actor, {
      eventId: event.id,
      action: 'fixtures.imported',
      subjectType: 'event',
      subjectId: event.id,
      summary: `Imported ${event.name} from fixtures.json: ${counts.projects} projects, ${counts.teams} teams, ${counts.judges} judges, ${counts.scores} scores.`,
      detail: { counts, warnings },
    });
    for (const dup of report.duplicates) {
      record(store, actor, {
        eventId: event.id,
        action: 'project.duplicate_detected',
        subjectType: 'project',
        subjectId: dup.kept,
        summary: `Team ${dup.team} submitted more than once. ${dup.kept} (the latest) counts; ${dup.replaced.join(', ')} kept on record as replaced. An organizer can reverse this.`,
      });
    }
  });
  return report;
}
