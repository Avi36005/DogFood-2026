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

function groupScores(observations: Observation[], key: (o: Observation) => string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const obs of observations) {
    const list = out.get(key(obs)) ?? [];
    list.push(obs.score);
    out.set(key(obs), list);
  }
  return out;
}

// Publishing ----------------------------------------------------------------------------

/**
 * Freezes the ranking into a snapshot with the method, lambda and weights that produced it,
 * closes judging, and makes the results public. Publishing again supersedes the previous
 * snapshot; both stay on record.
 */
export function publishResults(store: Store, actor: Actor, event: EventRow): string {
  const organizer = requireOrganizer(store, actor, event, `publish the results of ${event.name}`);
  const now = iso(actor.now);
  if (now < event.submissions_close_at) throw conflict(`Submissions are still open until ${formatUtc(event.submissions_close_at)}. Close them first.`);
  return store.tx(() => {
    const result = computeStandings(store, event);
    if (result.reviewCount === 0) throw conflict('There are no submitted reviews to publish.');
    const id = newId('res');
    store.run('UPDATE result_snapshots SET superseded_at = ? WHERE event_id = ? AND superseded_at IS NULL', [now, event.id]);
    store.run(
      `INSERT INTO result_snapshots (id, event_id, method, lambda, weights, review_count, published_at, published_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, event.id, result.method, result.lambda, JSON.stringify(Object.fromEntries(result.weights.map((w) => [w.key, w.weight]))), result.reviewCount, now, organizer.id],
    );
    for (const s of result.standings) {
      if (s.rank === null || s.score === null || s.raw_mean === null) continue;
      store.run(
        'INSERT INTO result_rows (snapshot_id, project_id, rank, score, raw_mean, review_count, low_coverage) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, s.project_id, s.rank, s.score, s.raw_mean, s.review_count, s.low_coverage ? 1 : 0],
      );
    }
    for (const j of result.judges) {
      store.run('INSERT INTO result_judge_offsets (snapshot_id, judge_id, offset, review_count) VALUES (?, ?, ?, ?)', [id, j.judge_id, j.offset, j.review_count]);
    }
    store.run(
      `UPDATE events SET results_published_at = $now,
         judging_close_at = CASE WHEN judging_close_at IS NULL OR judging_close_at > $now THEN $now ELSE judging_close_at END,
         updated_at = $now WHERE id = $id`,
      { now, id: event.id },
    );
    const top = result.standings.filter((s) => s.rank !== null).slice(0, 3).map((s) => `${s.rank}. ${s.title}`).join(', ');
    record(store, actor, {
      eventId: event.id,
      action: 'results.published',
      subjectType: 'result_snapshot',
      subjectId: id,
      summary: `Published results from ${result.reviewCount} reviews with ${result.method}, lambda ${result.lambda}. Top: ${top}.`,
      detail: { weights: result.weights, mu: result.mu },
    });
    return id;
  });
}

export function unpublishResults(store: Store, actor: Actor, event: EventRow): void {
  requireOrganizer(store, actor, event, `withdraw the results of ${event.name}`);
  if (!event.results_published_at) throw conflict('Results are not published.');
  store.tx(() => {
    const now = iso(actor.now);
    store.run('UPDATE result_snapshots SET superseded_at = ? WHERE event_id = ? AND superseded_at IS NULL', [now, event.id]);
    store.run('UPDATE events SET results_published_at = NULL, updated_at = ? WHERE id = ?', [now, event.id]);
    record(store, actor, {
      eventId: event.id,
      action: 'results.withdrawn',
      subjectType: 'event',
      subjectId: event.id,
      summary: 'Withdrew the published results. Judging stays closed until the judging close date is changed in settings.',
    });
  });
}

export interface PublishedRow {
  project_id: string;
  title: string;
  team_name: string;
  track_name: string | null;
  rank: number;
  score: number;
  raw_mean: number;
  review_count: number;
  low_coverage: 0 | 1;
}

export interface Snapshot {
  id: string;
  method: string;
  lambda: number;
  weights: string;
  review_count: number;
  published_at: string;
  superseded_at: string | null;
  published_by_name: string | null;
}

/** The public view: only when the event says results are published. */
export function publishedResults(store: Store, event: EventRow): { snapshot: Snapshot; rows: PublishedRow[] } | null {
  if (!event.results_published_at) return null;
  const snapshot = store.get<Snapshot>(
    `SELECT s.*, u.name AS published_by_name FROM result_snapshots s LEFT JOIN users u ON u.id = s.published_by
     WHERE s.event_id = ? AND s.superseded_at IS NULL`,
    [event.id],
  );
  if (!snapshot) return null;
  const rows = store.all<PublishedRow>(
    `SELECT r.project_id, p.title, t.name AS team_name, tr.name AS track_name, r.rank, r.score, r.raw_mean, r.review_count, r.low_coverage
     FROM result_rows r JOIN projects p ON p.id = r.project_id JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id
     WHERE r.snapshot_id = ? ORDER BY r.rank, p.title`,
    [snapshot.id],
  );
  return { snapshot, rows };
}

export function listSnapshots(store: Store, eventId: string): Snapshot[] {
  return store.all<Snapshot>(
    `SELECT s.*, u.name AS published_by_name FROM result_snapshots s LEFT JOIN users u ON u.id = s.published_by
     WHERE s.event_id = ? ORDER BY s.published_at DESC`,
    [eventId],
  );
}
