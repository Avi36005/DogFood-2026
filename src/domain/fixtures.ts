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

