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

/**
 * Computes the current ranking from submitted reviews of submitted, current projects.
 * Superseded duplicates, withdrawn projects and draft reviews are left out. Nothing is stored.
 */
export function computeStandings(store: Store, event: EventRow, lambda = DEFAULT_LAMBDA): Standings {
  const criteria = listCriteria(store, event.id);
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  const rows = store.all<ReviewScoreRow>(
    `SELECT a.id AS assignment_id, a.judge_id, a.project_id, s.criterion_id, s.value
     FROM assignments a JOIN reviews r ON r.assignment_id = a.id JOIN review_scores s ON s.assignment_id = a.id
     JOIN projects p ON p.id = a.project_id
     WHERE a.event_id = ? AND r.status = 'submitted' AND p.status = 'submitted' AND p.superseded_by IS NULL`,
    [event.id],
  );

  const reviews = new Map<string, { judge: string; project: string; values: Map<string, number> }>();
  for (const row of rows) {
    const review = reviews.get(row.assignment_id) ?? { judge: row.judge_id, project: row.project_id, values: new Map() };
    review.values.set(row.criterion_id, row.value);
    reviews.set(row.assignment_id, review);
  }
  const observations: Observation[] = [];
  const vectors = new Map<string, Set<string>>();
  for (const review of reviews.values()) {
    const vector = criteria.map((c) => review.values.get(c.id) ?? '').join('/');
    vectors.set(review.judge, (vectors.get(review.judge) ?? new Set()).add(vector));
    const score = weightedScore(review.values, criteria);
    if (score !== null) observations.push({ judge: review.judge, project: review.project, score });
  }

  const model = fitOffsets(observations, { lambda });
  const projects = store.all<{ id: string; title: string; team_name: string; track_name: string | null }>(
    `SELECT p.id, p.title, t.name AS team_name, tr.name AS track_name FROM projects p JOIN teams t ON t.id = p.team_id
     LEFT JOIN tracks tr ON tr.id = p.track_id
     WHERE p.event_id = ? AND p.status = 'submitted' AND p.superseded_by IS NULL`,
    [event.id],
  );
  const byProject = groupScores(observations, (o) => o.project);
  const unranked: Standing[] = [];
  const ranked: Standing[] = [];
  for (const project of projects) {
    const scores = byProject.get(project.id) ?? [];
    const standing: Standing = {
      project_id: project.id,
      title: project.title,
      team_name: project.team_name,
      track_name: project.track_name,
      review_count: scores.length,
      raw_mean: scores.length ? mean(scores) : null,
      score: scores.length ? model.mu + (model.projectEffect.get(project.id) ?? 0) : null,
      rank: null,
      raw_rank: null,
      low_coverage: scores.length < LOW_COVERAGE_BELOW,
    };
    (scores.length ? ranked : unranked).push(standing);
  }

  const byRaw = [...ranked].sort((x, y) => (y.raw_mean as number) - (x.raw_mean as number) || x.title.localeCompare(y.title));
  const rawRanks = competitionRanks(byRaw, (s) => s.raw_mean as number);
  ranked.sort((x, y) => (y.score as number) - (x.score as number) || (y.raw_mean as number) - (x.raw_mean as number) || x.title.localeCompare(y.title));
  const ranks = competitionRanks(ranked, (s) => s.score as number);
  for (const standing of ranked) {
    standing.rank = ranks.get(standing) ?? null;
    standing.raw_rank = rawRanks.get(standing) ?? null;
  }
  unranked.sort((x, y) => x.title.localeCompare(y.title));

  const names = new Map(
    store.all<{ id: string; name: string }>("SELECT u.id, u.name FROM event_roles r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.role = 'judge'", [event.id])
      .map((row) => [row.id, row.name]),
  );
  const byJudge = groupScores(observations, (o) => o.judge);
  // "Harsh" and "generous" start at an eighth of the scale: half a point on a 1-5 scale.
  const notable = (event.score_max - event.score_min) / 8;
  const judges: JudgeStat[] = [...byJudge.entries()]
    .map(([judgeId, scores]) => {
      const offset = model.judgeOffset.get(judgeId) ?? 0;
      const flags: JudgeFlag[] = [];
      if (scores.length >= 2 && Math.max(...scores) - Math.min(...scores) < 1e-9) {
        flags.push((vectors.get(judgeId)?.size ?? 0) === 1 ? 'identical-scores' : 'same-total');
      }
      if (scores.length <= 2) flags.push('few-reviews');
      if (offset <= -notable) flags.push('harsh');
      if (offset >= notable) flags.push('generous');
      return { judge_id: judgeId, name: names.get(judgeId) ?? judgeId, review_count: scores.length, mean_given: mean(scores), offset, flags };
    })
    .sort((x, y) => x.offset - y.offset || x.name.localeCompare(y.name));

  return {
    method: model.method,
    lambda,
    mu: model.mu,
    iterations: model.iterations,
    converged: model.converged,
    reviewCount: observations.length,
    weights: criteria.map((c) => ({ key: c.key, name: c.name, weight: c.weight, share: totalWeight ? c.weight / totalWeight : 0 })),
    standings: [...ranked, ...unranked],
    judges,
  };
}

