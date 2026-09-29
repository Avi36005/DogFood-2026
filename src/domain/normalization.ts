/**
 * Cross-judge normalization: additive judge offsets with ridge shrinkage.
 *
 * Model. Each submitted review gives one weighted score x (on the event's scale) from judge j
 * for project p:
 *
 *     x_jp = mu + a_p + b_j + noise
 *
 * mu is the mean of all reviews, a_p is how much better or worse project p is than average,
 * and b_j is judge j's offset: positive for a generous judge, negative for a harsh one.
 *
 * Fit. Minimize  sum (x_jp - mu - a_p - b_j)^2 + lambda * sum b_j^2  by alternating exact
 * block updates (coordinate descent), which converges to the unique minimum:
 *
 *     a_p = mean over p's reviews of (x_jp - mu - b_j)
 *     b_j = sum over j's reviews of (x_jp - mu - a_p) / (n_j + lambda)
 *
 * The lambda term shrinks each offset toward zero as if the judge had filed lambda extra
 * reviews with no bias, so a judge seen once cannot be declared harsh on one data point.
 * The ranking value is mu + a_p: the project's score with each judge's offset taken out.
 *
 * Why this and not per-judge z-scores: see JUDGING.md. In short, with one to eleven reviews
 * per judge a judge's spread cannot be estimated, and z-scores ranked worse than raw means
 * in simulation on the fixture's own judge-project layout.
 */

export interface Observation {
  judge: string;
  project: string;
  score: number;
}

export interface OffsetModel {
  method: typeof METHOD;
  lambda: number;
  mu: number;
  /** a_p: project effect relative to mu. */
  projectEffect: Map<string, number>;
  /** b_j: judge offset. Positive means generous. */
  judgeOffset: Map<string, number>;
  iterations: number;
  converged: boolean;
}

export const METHOD = 'additive-offsets-ridge/v1';
export const DEFAULT_LAMBDA = 2;

export interface FitOptions {
  lambda?: number;
  maxIterations?: number;
  tolerance?: number;
}

export function fitOffsets(observations: readonly Observation[], options: FitOptions = {}): OffsetModel {
  const lambda = options.lambda ?? DEFAULT_LAMBDA;
  const maxIterations = options.maxIterations ?? 10_000;
  const tolerance = options.tolerance ?? 1e-12;
  if (lambda < 0 || !Number.isFinite(lambda)) throw new RangeError('lambda must be a non-negative number');

  const byProject = new Map<string, Observation[]>();
  const byJudge = new Map<string, Observation[]>();
  for (const obs of observations) {
    if (!Number.isFinite(obs.score)) throw new RangeError(`score for ${obs.judge}/${obs.project} is not a number`);
    push(byProject, obs.project, obs);
    push(byJudge, obs.judge, obs);
  }
  // Sorted keys make every run visit the data in the same order: same input, same bits out.
  const projects = [...byProject.keys()].sort();
  const judges = [...byJudge.keys()].sort();
  const mu = observations.length ? observations.reduce((sum, o) => sum + o.score, 0) / observations.length : 0;
  const a = new Map(projects.map((p) => [p, 0]));
  const b = new Map(judges.map((j) => [j, 0]));

  let iterations = 0;
  let converged = observations.length === 0;
  while (!converged && iterations < maxIterations) {
    iterations++;
    let change = 0;
    for (const p of projects) {
      const reviews = byProject.get(p) ?? [];
      const next = reviews.reduce((sum, o) => sum + (o.score - mu - (b.get(o.judge) ?? 0)), 0) / reviews.length;
      change = Math.max(change, Math.abs(next - (a.get(p) ?? 0)));
      a.set(p, next);
    }
    for (const j of judges) {
      const reviews = byJudge.get(j) ?? [];
      const next = reviews.reduce((sum, o) => sum + (o.score - mu - (a.get(o.project) ?? 0)), 0) / (reviews.length + lambda);
      change = Math.max(change, Math.abs(next - (b.get(j) ?? 0)));
      b.set(j, next);
    }
    if (lambda === 0) {
      // Without shrinkage the model is only identified up to a constant; pin the offsets to mean zero.
      const shift = judges.reduce((sum, j) => sum + (b.get(j) ?? 0), 0) / (judges.length || 1);
      for (const j of judges) b.set(j, (b.get(j) ?? 0) - shift);
      for (const p of projects) a.set(p, (a.get(p) ?? 0) + shift);
    }
    converged = change < tolerance;
  }

  return { method: METHOD, lambda, mu, projectEffect: a, judgeOffset: b, iterations, converged };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Weighted mean of criterion values: sum(w * v) / sum(w). Every criterion must be present. */
export function weightedScore(values: ReadonlyMap<string, number>, weights: readonly { id: string; weight: number }[]): number | null {
  let total = 0;
  let weightSum = 0;
  for (const { id, weight } of weights) {
    const value = values.get(id);
    if (value === undefined) return null;
    total += weight * value;
    weightSum += weight;
  }
  return weightSum > 0 ? total / weightSum : null;
}

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : Number.NaN;
}

/** Competition ranking (1, 2, 2, 4): equal values share a rank; ties are broken for display only. */
export function competitionRanks<T>(items: readonly T[], value: (item: T) => number): Map<T, number> {
  const ranks = new Map<T, number>();
  let previous: number | null = null;
  let previousRank = 0;
  items.forEach((item, index) => {
    const v = value(item);
    const rank = previous !== null && Math.abs(v - previous) < 1e-9 ? previousRank : index + 1;
    ranks.set(item, rank);
    previous = v;
    previousRank = rank;
  });
  return ranks;
}
