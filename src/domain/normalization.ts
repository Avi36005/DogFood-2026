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

