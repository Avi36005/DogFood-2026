import type { Store } from '../db/store.ts';
import { conflict } from '../util/errors.ts';
import { newId } from '../util/tokens.ts';
import { formatUtc, iso } from '../util/time.ts';
import { requireOrganizer } from './access.ts';
import { record } from './audit.ts';
import { listCriteria } from './events.ts';
import { competitionRanks, DEFAULT_LAMBDA, fitOffsets, mean, weightedScore, type Observation } from './normalization.ts';
import type { Actor, EventRow } from './types.ts';

/** A project with fewer submitted reviews than this is ranked but flagged. */
export const LOW_COVERAGE_BELOW = 2;

/**
 * identical-scores: every criterion of every review was the same (the fixture's jdg_07, 4/4/4).
 * same-total: criteria varied, but every weighted total came out equal, so the judge does not
 *   separate their projects either (the fixture's jdg_19 under equal weights).
 */
export type JudgeFlag = 'identical-scores' | 'same-total' | 'few-reviews' | 'harsh' | 'generous';

export interface Standing {
  project_id: string;
  title: string;
  team_name: string;
  track_name: string | null;
  review_count: number;
  raw_mean: number | null;
  score: number | null;
  rank: number | null;
  raw_rank: number | null;
  low_coverage: boolean;
}

export interface JudgeStat {
  judge_id: string;
  name: string;
  review_count: number;
  mean_given: number;
  offset: number;
  flags: JudgeFlag[];
}

export interface Standings {
  method: string;
  lambda: number;
  mu: number;
  iterations: number;
  converged: boolean;
  reviewCount: number;
  weights: { key: string; name: string; weight: number; share: number }[];
  standings: Standing[];
  judges: JudgeStat[];
}

interface ReviewScoreRow {
  assignment_id: string;
  judge_id: string;
  project_id: string;
  criterion_id: string;
  value: number;
}

