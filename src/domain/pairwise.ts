/**
 * Pairwise ranking with a Bradley–Terry model: the second opinion beside the rubric ranking.
 *
 * Model. Each project i has a strength π_i > 0, and P(i beats j) = π_i / (π_i + π_j). Strengths
 * are fitted by the MM algorithm (Hunter 2004): π_i ← W_i / Σ_j n_ij / (π_i + π_j), where W_i is
 * i's wins and n_ij the comparisons between i and j. Every step raises the likelihood and the fit
 * converges to its unique maximum.
 *
 * Prior. Each project also gets one virtual win and one virtual loss against a fixed reference
 * of strength 1. That keeps every strength finite (a project that won or lost everything would
 * otherwise run to infinity or zero) and pulls thinly compared projects gently toward the middle,
 * the same role λ plays in the rubric model.
 *
 * Where the comparisons come from:
 *   - judges' explicit choices in compare mode ("which of these two is better?"), and
 *   - comparisons implied by each judge's own rubric scores: if a judge scored A above B, that
 *     judge prefers A. A comparison is made inside one judge's scale, so a judge's leniency
 *     cancels out by construction, without any correction. A judge who gives everything the
 *     same score implies no comparisons at all, so the flat judge carries no weight here.
 * Pairwise never replaces the rubric ranking. It is shown beside it, with how much they agree.
 */
import type { Observation } from './normalization.ts';

export interface Comparison {
  judge: string;
  winner: string;
  loser: string;
}

export interface BradleyTerryFit {
  /** log π_i, centred on the reference (0 = as strong as the prior's reference). */
  theta: Map<string, number>;
  wins: Map<string, number>;
  losses: Map<string, number>;
  comparisons: number;
  iterations: number;
  converged: boolean;
}

const PRIOR_GAMES = 1;

export function fitBradleyTerry(comparisons: readonly Comparison[], options: { maxIterations?: number; tolerance?: number } = {}): BradleyTerryFit {
  const maxIterations = options.maxIterations ?? 10_000;
  const tolerance = options.tolerance ?? 1e-12;
  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  const games = new Map<string, Map<string, number>>();
  const add = (a: string, b: string) => {
    const row = games.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + 1);
    games.set(a, row);
  };
  for (const c of comparisons) {
    if (c.winner === c.loser) continue;
    wins.set(c.winner, (wins.get(c.winner) ?? 0) + 1);
    losses.set(c.loser, (losses.get(c.loser) ?? 0) + 1);
    add(c.winner, c.loser);
    add(c.loser, c.winner);
  }
  const items = [...games.keys()].sort();
  let pi = new Map(items.map((i) => [i, 1]));
  let iterations = 0;
  let converged = items.length === 0;
  while (!converged && iterations < maxIterations) {
    iterations++;
    const next = new Map<string, number>();
    for (const i of items) {
      const pii = pi.get(i) as number;
      let denominator = (2 * PRIOR_GAMES) / (pii + 1); // one virtual win and one virtual loss against strength 1
      for (const [j, n] of games.get(i) ?? []) denominator += n / (pii + (pi.get(j) as number));
      next.set(i, ((wins.get(i) ?? 0) + PRIOR_GAMES) / denominator);
    }
    let change = 0;
    for (const i of items) change = Math.max(change, Math.abs(Math.log(next.get(i) as number) - Math.log(pi.get(i) as number)));
    pi = next;
    converged = change < tolerance;
  }
  return {
    theta: new Map(items.map((i) => [i, Math.log(pi.get(i) as number)])),
    wins,
    losses,
    comparisons: comparisons.filter((c) => c.winner !== c.loser).length,
    iterations,
    converged,
  };
}

/** P(a beats b) under the fit. */
export function winProbability(fit: BradleyTerryFit, a: string, b: string): number {
  const ta = fit.theta.get(a) ?? 0;
  const tb = fit.theta.get(b) ?? 0;
  return 1 / (1 + Math.exp(tb - ta));
}

/** Every pair of one judge's reviews with different scores becomes one comparison; ties imply nothing. */
export function impliedComparisons(observations: readonly Observation[]): Comparison[] {
  const byJudge = new Map<string, Observation[]>();
  for (const o of observations) byJudge.set(o.judge, [...(byJudge.get(o.judge) ?? []), o]);
  const out: Comparison[] = [];
  for (const [judge, list] of [...byJudge].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...list].sort((a, b) => (a.project < b.project ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i] as Observation;
        const b = sorted[j] as Observation;
        if (Math.abs(a.score - b.score) < 1e-9) continue;
        out.push(a.score > b.score ? { judge, winner: a.project, loser: b.project } : { judge, winner: b.project, loser: a.project });
      }
    }
  }
  return out;
}

/** Items ordered by strength, strongest first; ids break exact ties so the order is total. */
export function orderByStrength(fit: BradleyTerryFit): string[] {
  return [...fit.theta.keys()].sort((a, b) => (fit.theta.get(b) as number) - (fit.theta.get(a) as number) || (a < b ? -1 : 1));
}

/** Spearman's ρ between two orders, over the items both contain (no ties: the orders are total). */
export function spearman(first: readonly string[], second: readonly string[]): { rho: number; n: number } {
  const inSecond = new Set(second);
  const common = first.filter((x) => inSecond.has(x));
  const rank = (order: readonly string[]) => new Map(order.filter((x) => common.includes(x)).map((x, i) => [x, i + 1]));
  const r1 = rank(first);
  const r2 = rank(second);
  const n = common.length;
  if (n < 2) return { rho: 1, n };
  const d2 = common.reduce((sum, x) => sum + ((r1.get(x) as number) - (r2.get(x) as number)) ** 2, 0);
  return { rho: 1 - (6 * d2) / (n * (n * n - 1)), n };
}

/**
 * The next pair for a judge in compare mode: among their own assigned projects, the pair they
 * have not compared yet that has been compared least by anyone, and among those, the pair whose
 * current strengths are closest (the comparison that teaches the model most). Ids break ties.
 */
export function nextPair(assigned: readonly string[], done: ReadonlySet<string>, counts: ReadonlyMap<string, number>, fit: BradleyTerryFit): [string, string] | null {
  const ids = [...new Set(assigned)].sort();
  let best: { pair: [string, string]; count: number; gap: number } | null = null;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      const key = pairKey(a, b);
      if (done.has(key)) continue;
      const count = counts.get(key) ?? 0;
      const gap = Math.abs((fit.theta.get(a) ?? 0) - (fit.theta.get(b) ?? 0));
      if (!best || count < best.count || (count === best.count && gap < best.gap - 1e-12)) best = { pair: [a, b], count, gap };
    }
  }
  return best?.pair ?? null;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
