/**
 * How sure is the ranking? Three answers, all computed from the same model as the ranking itself
 * (see normalization.ts) and all deterministic: the same reviews give the same numbers.
 *
 * 1. Rank intervals, by a seeded residual bootstrap. Fit the model once, take the residuals
 *    x_jp - (mu + a_p + b_j), and build many simulated events that keep the real judge-project
 *    layout: x*_jp = mu + a_p + b_j + e*, with e* drawn from the residuals. Refit each one and
 *    rank it. A project's 90% interval is the 5th to 95th percentile of its simulated ranks.
 *    Residuals from a fitted model are smaller than the true noise, because the fit has used
 *    some of the data's freedom; they are scaled up by sqrt(n / (n - df)), with
 *    df = projects + sum over judges of n_j / (n_j + lambda), the effective number of fitted
 *    effects under shrinkage. Drawing noise from the pooled residuals (rather than resampling a
 *    project's own reviews) gives a project with one review an honest, wide interval instead of
 *    a falsely certain one.
 *
 * 2. Podium stability, by leaving out one judge at a time. Refit without each judge and ask
 *    whether first place, and the set of the top three, stay the same. A judge whose removal
 *    changes the podium is named, so an organizer can see when one person decides the outcome.
 *
 * 3. Separation at the prize line. For each pair of adjacent places inside the prizes, the share
 *    of simulated events that keep them in this order, and a rough count of extra reviews each
 *    would need before the gap is 1.645 standard errors wide (one-sided 95%), assuming the gap
 *    is real. It uses sigma^2 / n per project and ignores the uncertainty in judge offsets, so it
 *    is a lower bound: a planning number, not a guarantee.
 */
import { fitOffsets, type Observation, type OffsetModel } from './normalization.ts';

export const BOOTSTRAP_REPLICATES = 400;
export const BOOTSTRAP_SEED = 20_260_926;
export const INTERVAL_LEVEL = 0.9;
export const PRIZE_PLACES = 3;
/** A pair is "separated" when at least this share of simulated events keeps its order. */
export const SEPARATED_AT = 0.9;
const Z_ONE_SIDED_95 = 1.645;
/** Beyond this many extra reviews each, the pair is reported as not separable in practice. */
export const PRACTICAL_EXTRA_REVIEWS = 10;
const SEARCH_LIMIT = 10_000;

export interface RankInterval {
  lo: number;
  hi: number;
  /** Share of simulated events in which the project finished inside the prize places. */
  podiumShare: number;
}

export interface JudgeInfluence {
  judge: string;
  /** First place without this judge, or null if no project could be ranked. */
  winner: string | null;
  podium: string[];
  changesWinner: boolean;
  changesPodium: boolean;
}

export interface Stability {
  refits: number;
  winner: string | null;
  podium: string[];
  winnerHolds: number;
  podiumHolds: number;
  /** Only the judges whose removal changes first place or the podium. */
  influential: JudgeInfluence[];
}

export interface Separation {
  place: number;
  above: string;
  below: string;
  gap: number;
  /** Share of simulated events that keep `above` ahead of `below`. */
  orderShare: number;
  separated: boolean;
  /**
   * Extra reviews each would need; 0 if the gap is already wide enough, null if the gap is
   * effectively zero. Above PRACTICAL_EXTRA_REVIEWS the honest reading is "a tie" either way.
   */
  reviewsEach: number | null;
}

export interface Uncertainty {
  replicates: number;
  seed: number;
  level: number;
  prizePlaces: number;
  /** Estimated noise of one review, on the event's scale. */
  sigma: number;
  intervals: Map<string, RankInterval>;
  stability: Stability;
  separations: Separation[];
}

export interface UncertaintyOptions {
  lambda: number;
  replicates?: number;
  seed?: number;
  prizePlaces?: number;
}

/** Projects ordered best first: fitted score, then raw mean, then id, so the order is total. */
export function orderProjects(model: OffsetModel, observations: readonly Observation[]): string[] {
  const raw = new Map<string, { sum: number; n: number }>();
  for (const o of observations) {
    const r = raw.get(o.project) ?? { sum: 0, n: 0 };
    r.sum += o.score;
    r.n++;
    raw.set(o.project, r);
  }
  const score = (p: string) => model.mu + (model.projectEffect.get(p) ?? 0);
  const rawMean = (p: string) => {
    const r = raw.get(p);
    return r ? r.sum / r.n : 0;
  };
  return [...raw.keys()].sort((x, y) => score(y) - score(x) || rawMean(y) - rawMean(x) || (x < y ? -1 : x > y ? 1 : 0));
}

export function assessUncertainty(observations: readonly Observation[], options: UncertaintyOptions): Uncertainty {
  const lambda = options.lambda;
  const replicates = options.replicates ?? BOOTSTRAP_REPLICATES;
  const seed = options.seed ?? BOOTSTRAP_SEED;
  const prizePlaces = options.prizePlaces ?? PRIZE_PLACES;
  const model = fitOffsets(observations, { lambda });
  const order = orderProjects(model, observations);

  const fitted = observations.map((o) => model.mu + (model.projectEffect.get(o.project) ?? 0) + (model.judgeOffset.get(o.judge) ?? 0));
  const residuals = observations.map((o, i) => o.score - (fitted[i] as number));
  const sigma = residualSigma(observations, residuals, lambda);
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / (residuals.length || 1));
  const scale = rms > 0 ? sigma / rms : 0;
  const centre = residuals.reduce((s, r) => s + r, 0) / (residuals.length || 1);
  const noise = residuals.map((r) => (r - centre) * scale);

  // Simulated ranks: ranks[p] is the list of places p took, one per replicate.
  const ranks = new Map(order.map((p) => [p, [] as number[]]));
  const pairAhead = new Map<string, number>();
  const pairs = order.slice(0, prizePlaces).map((p, i) => [p, order[i + 1]] as const).filter((pair): pair is readonly [string, string] => pair[1] !== undefined);
  const random = mulberry32(seed);
  // Replicates only need rank-level precision, so the fit can stop earlier than the published one.
  for (let r = 0; r < replicates && noise.length; r++) {
    const simulated = observations.map((o, i) => ({ judge: o.judge, project: o.project, score: (fitted[i] as number) + (noise[Math.floor(random() * noise.length)] as number) }));
    const refit = fitOffsets(simulated, { lambda, tolerance: 1e-9 });
    const simOrder = orderProjects(refit, simulated);
    simOrder.forEach((p, index) => ranks.get(p)?.push(index + 1));
    const place = new Map(simOrder.map((p, index) => [p, index]));
    for (const [above, below] of pairs) {
      if ((place.get(above) ?? 0) < (place.get(below) ?? 0)) pairAhead.set(above + '|' + below, (pairAhead.get(above + '|' + below) ?? 0) + 1);
    }
  }

  const intervals = new Map<string, RankInterval>();
  order.forEach((p, index) => {
    const places = (ranks.get(p) ?? []).sort((a, b) => a - b);
    if (!places.length) {
      intervals.set(p, { lo: index + 1, hi: index + 1, podiumShare: index < prizePlaces ? 1 : 0 });
      return;
    }
    const tail = (1 - INTERVAL_LEVEL) / 2;
    intervals.set(p, {
      lo: quantile(places, tail),
      hi: quantile(places, 1 - tail),
      podiumShare: places.filter((place) => place <= prizePlaces).length / places.length,
    });
  });

  const counts = new Map<string, number>();
  for (const o of observations) counts.set(o.project, (counts.get(o.project) ?? 0) + 1);
  const scoreOf = (p: string) => model.mu + (model.projectEffect.get(p) ?? 0);
  const separations: Separation[] = pairs.map(([above, below], index) => {
    const gap = scoreOf(above) - scoreOf(below);
    const orderShare = replicates && noise.length ? (pairAhead.get(above + '|' + below) ?? 0) / replicates : 1;
    return {
      place: index + 1,
      above,
      below,
      gap,
      orderShare,
      separated: orderShare >= SEPARATED_AT,
      reviewsEach: reviewsToSeparate(gap, sigma, counts.get(above) ?? 0, counts.get(below) ?? 0),
    };
  });

  return { replicates, seed, level: INTERVAL_LEVEL, prizePlaces, sigma, intervals, stability: podiumStability(observations, lambda, order, prizePlaces), separations };
}

/** Leave each judge out in turn, refit, and compare first place and the podium with the full fit. */
export function podiumStability(observations: readonly Observation[], lambda: number, order: readonly string[], prizePlaces = PRIZE_PLACES): Stability {
  const judges = [...new Set(observations.map((o) => o.judge))].sort();
  const winner = order[0] ?? null;
  const podium = order.slice(0, prizePlaces);
  const podiumKey = [...podium].sort().join('|');
  let winnerHolds = 0;
  let podiumHolds = 0;
  const influential: JudgeInfluence[] = [];
  for (const judge of judges) {
    const rest = observations.filter((o) => o.judge !== judge);
    const refitOrder = orderProjects(fitOffsets(rest, { lambda }), rest);
    const without: JudgeInfluence = {
      judge,
      winner: refitOrder[0] ?? null,
      podium: refitOrder.slice(0, prizePlaces),
      changesWinner: (refitOrder[0] ?? null) !== winner,
      changesPodium: [...refitOrder.slice(0, prizePlaces)].sort().join('|') !== podiumKey,
    };
    if (!without.changesWinner) winnerHolds++;
    if (!without.changesPodium) podiumHolds++;
    if (without.changesWinner || without.changesPodium) influential.push(without);
  }
  return { refits: judges.length, winner, podium, winnerHolds, podiumHolds, influential };
}

/**
 * Smallest m such that 1.645 * sigma * sqrt(1/(nA+m) + 1/(nB+m)) <= gap. 0 when already met,
 * null when the gap is effectively zero or would take more than SEARCH_LIMIT reviews each: a tie.
 */
export function reviewsToSeparate(gap: number, sigma: number, nAbove: number, nBelow: number): number | null {
  if (!(gap > 1e-9)) return null;
  if (sigma <= 0) return 0;
  for (let m = 0; m <= SEARCH_LIMIT; m++) {
    const se = sigma * Math.sqrt(1 / Math.max(nAbove + m, 1) + 1 / Math.max(nBelow + m, 1));
    if (Z_ONE_SIDED_95 * se <= gap) return m;
  }
  return null;
}

/** sqrt(RSS / (n - df)) with df = projects + sum_j n_j / (n_j + lambda); falls back to the plain RMS. */
export function residualSigma(observations: readonly Observation[], residuals: readonly number[], lambda: number): number {
  const n = observations.length;
  if (!n) return 0;
  const rss = residuals.reduce((s, r) => s + r * r, 0);
  const perJudge = new Map<string, number>();
  const projects = new Set<string>();
  for (const o of observations) {
    perJudge.set(o.judge, (perJudge.get(o.judge) ?? 0) + 1);
    projects.add(o.project);
  }
  let df = projects.size;
  for (const nj of perJudge.values()) df += lambda > 0 ? nj / (nj + lambda) : 1;
  // With less than one degree of freedom left the correction is meaningless; fall back to the RMS.
  return Math.sqrt(rss / (n - df >= 1 ? n - df : n));
}

/** Nearest-rank percentile of a sorted list (no interpolation: ranks are whole places). */
function quantile(sorted: readonly number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] as number;
}

/** Small, fast, seeded PRNG (public domain). Same seed, same sequence, on every platform. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
