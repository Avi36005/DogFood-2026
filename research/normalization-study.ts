/**
 * Normalization study: which cross-judge correction recovers the truth best on the DOGFOOD
 * fixture's own judge-project layout?  Run with `npm run study`. Deterministic (seeded).
 *
 * Method. Keep exactly who-reviewed-what from fixtures.json (121 reviews of the 40 current
 * projects; prj_07 is excluded as a replaced duplicate, as the portal does). Invent a known
 * truth, generate scores from it, apply each method, and measure how well its ranking matches
 * the truth. Repeat for many simulated events and for several assumptions about judges.
 *
 * Generative model for one review (three criteria, integers 1-5, like the fixture):
 *   criterion score = round(clamp(3 + spread_j * (quality_p + noise) + bias_j, 1, 5))
 *   quality_p ~ N(0, SD_Q), bias_j ~ N(0, SD_B), noise ~ N(0, SD_E) per criterion,
 *   spread_j = 1 (equal spread) or log-uniform in [0.5, 2] (judges differ in spread too).
 * The review's score is the mean of its three criteria, as the portal computes it with equal weights.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fitOffsets, mean, type Observation } from '../src/domain/normalization.ts';

interface Layout { pairs: { judge: string; project: string }[]; judges: string[]; projects: string[] }

function fixtureLayout(): Layout {
  const file = path.join(import.meta.dirname, '..', 'fixtures.json');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8')) as { scores: { judge: string; project: string }[] };
  const pairs = fixture.scores.filter((s) => s.project !== 'prj_07').map(({ judge, project }) => ({ judge, project }));
  return { pairs, judges: [...new Set(pairs.map((p) => p.judge))].sort(), projects: [...new Set(pairs.map((p) => p.project))].sort() };
}

// mulberry32: small, seedable PRNG so every run prints the same table.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

type Method = (obs: Observation[]) => Map<string, number>;

const rawMean: Method = (obs) => {
  const by = new Map<string, number[]>();
  for (const o of obs) by.set(o.project, [...(by.get(o.project) ?? []), o.score]);
  return new Map([...by].map(([p, xs]) => [p, mean(xs)]));
};

/** Per-judge population z-scores; judges with fewer than `min` reviews or zero spread are dropped. */
const zScore = (min: number): Method => (obs) => {
  const byJudge = new Map<string, number[]>();
  for (const o of obs) byJudge.set(o.judge, [...(byJudge.get(o.judge) ?? []), o.score]);
  const stats = new Map<string, { m: number; s: number }>();
  for (const [j, xs] of byJudge) {
    const m = mean(xs);
    const s = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    if (xs.length >= min && s > 1e-9) stats.set(j, { m, s });
  }
  const by = new Map<string, number[]>();
  for (const o of obs) {
    const st = stats.get(o.judge);
    if (st) by.set(o.project, [...(by.get(o.project) ?? []), (o.score - st.m) / st.s]);
  }
  return new Map([...by].map(([p, zs]) => [p, mean(zs)]));
};

const offsets = (lambda: number): Method => (obs) => {
  const model = fitOffsets(obs, { lambda });
  return new Map([...model.projectEffect].map(([p, a]) => [p, model.mu + a]));
};

function ranks(values: Map<string, number>): Map<string, number> {
  const sorted = [...values].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  return new Map(sorted.map(([p], i) => [p, i + 1]));
}

/** Spearman correlation over the projects the method ranked. */
function spearman(estimate: Map<string, number>, truth: Map<string, number>): number {
  const common = new Map([...truth].filter(([p]) => estimate.has(p)));
  const re = ranks(new Map([...estimate].filter(([p]) => common.has(p))));
  const rt = ranks(common);
  const n = common.size;
  let d2 = 0;
  for (const p of common.keys()) d2 += ((re.get(p) ?? 0) - (rt.get(p) ?? 0)) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function topKRecall(estimate: Map<string, number>, truth: Map<string, number>, k = 5): number {
  const top = (m: Map<string, number>) => new Set([...ranks(m)].filter(([, r]) => r <= k).map(([p]) => p));
  const t = top(truth);
  return [...top(estimate)].filter((p) => t.has(p)).length / k;
}

const METHODS: [string, Method][] = [
  ['A  raw mean', rawMean],
  ['B  z-score, judges with >= 3 reviews', zScore(3)],
  ['C  z-score, judges with >= 2 reviews', zScore(2)],
  ['D  offsets, no shrinkage (lambda 0)', offsets(0)],
  ['E  offsets, lambda 2 (Forgeboard)', offsets(2)],
  ['F  offsets, lambda 5', offsets(5)],
];

interface Scenario { name: string; sdQ: number; sdB: number; sdE: number; spread: boolean }

function simulate(layout: Layout, scenario: Scenario, runs: number, seed: number) {
  const random = rng(seed);
  const totals = METHODS.map(() => ({ rho: 0, top: 0, ranked: 0 }));
  for (let run = 0; run < runs; run++) {
    const quality = new Map(layout.projects.map((p) => [p, scenario.sdQ * normal(random)]));
    const bias = new Map(layout.judges.map((j) => [j, scenario.sdB * normal(random)]));
    const spread = new Map(layout.judges.map((j) => [j, scenario.spread ? Math.exp(Math.log(0.5) + random() * Math.log(4)) : 1]));
    const obs: Observation[] = layout.pairs.map(({ judge, project }) => {
      const criteria = [0, 1, 2].map(() => {
        const x = 3 + (spread.get(judge) ?? 1) * ((quality.get(project) ?? 0) + scenario.sdE * normal(random)) + (bias.get(judge) ?? 0);
        return Math.round(Math.min(5, Math.max(1, x)));
      });
      return { judge, project, score: mean(criteria) };
    });
    METHODS.forEach(([, method], i) => {
      const estimate = method(obs);
      const total = totals[i];
      if (!total) return;
      total.rho += spearman(estimate, quality);
      total.top += topKRecall(estimate, quality);
      total.ranked += estimate.size;
    });
  }
  return totals.map((t) => ({ rho: t.rho / runs, top: t.top / runs, ranked: t.ranked / runs }));
}

function lambdaSweep(layout: Layout, scenario: Scenario, runs: number, seed: number, lambdas: number[]) {
  const random = rng(seed);
  const rho = lambdas.map(() => 0);
  for (let run = 0; run < runs; run++) {
    const quality = new Map(layout.projects.map((p) => [p, scenario.sdQ * normal(random)]));
    const bias = new Map(layout.judges.map((j) => [j, scenario.sdB * normal(random)]));
    const obs = layout.pairs.map(({ judge, project }) => ({
      judge, project,
      score: mean([0, 1, 2].map(() => Math.round(Math.min(5, Math.max(1, 3 + (quality.get(project) ?? 0) + scenario.sdE * normal(random) + (bias.get(judge) ?? 0)))))),
    }));
    lambdas.forEach((lambda, i) => { rho[i] = (rho[i] ?? 0) + spearman(offsets(lambda)(obs), quality); });
  }
  return rho.map((r) => r / runs);
}

const layout = fixtureLayout();
const RUNS = Number(process.env.RUNS ?? 300);
const reviewsPerJudge = layout.judges.map((j) => layout.pairs.filter((p) => p.judge === j).length);
console.log(`Layout from fixtures.json: ${layout.pairs.length} reviews, ${layout.projects.length} projects, ${layout.judges.length} judges`);
console.log(`Reviews per judge: min ${Math.min(...reviewsPerJudge)}, median ${reviewsPerJudge.sort((a, b) => a - b)[Math.floor(reviewsPerJudge.length / 2)]}, max ${Math.max(...reviewsPerJudge)}; ${RUNS} simulated events per scenario\n`);

const scenarios: Scenario[] = [
  { name: 'judges differ in bias only (SD 0.5)', sdQ: 0.7, sdB: 0.5, sdE: 0.8, spread: false },
  { name: 'judges differ in bias and in spread (x0.5 to x2)', sdQ: 0.7, sdB: 0.5, sdE: 0.8, spread: true },
  { name: 'strong bias (SD 0.8)', sdQ: 0.7, sdB: 0.8, sdE: 0.8, spread: false },
  { name: 'no bias at all (the null case)', sdQ: 0.7, sdB: 0, sdE: 0.8, spread: false },
];
for (const [i, scenario] of scenarios.entries()) {
  const results = simulate(layout, scenario, RUNS, 2026 + i);
  console.log(`Scenario: ${scenario.name}`);
  console.log('| Method | Rank correlation with truth | True top 5 found | Projects ranked |');
  console.log('|---|---|---|---|');
  METHODS.forEach(([name], m) => {
    const r = results[m];
    if (r) console.log(`| ${name} | ${r.rho.toFixed(3)} | ${(r.top * 100).toFixed(0)}% | ${r.ranked.toFixed(1)} |`);
  });
  console.log('');
}

const lambdas = [0, 0.5, 1, 2, 3, 5, 10, 25];
const sweep = lambdaSweep(layout, scenarios[0] as Scenario, RUNS, 99, lambdas);
console.log('Lambda sweep (bias-only scenario): rank correlation with truth');
console.log(`| lambda | ${lambdas.join(' | ')} |`);
console.log(`|---|${lambdas.map(() => '---').join('|')}|`);
console.log(`| rho | ${sweep.map((r) => r.toFixed(3)).join(' | ')} |`);
