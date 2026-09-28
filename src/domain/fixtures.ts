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

