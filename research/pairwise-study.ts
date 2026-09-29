/**
 * Pairwise study: is a Bradley–Terry ranking of within-judge comparisons a sound second opinion?
 * Run with `npm run study:pairwise`. Deterministic (seeded). Same layout, generative model and
 * scenarios as research/normalization-study.ts, so the numbers can be read side by side.
 *
 * The within-judge ranking turns each judge's reviews into comparisons (a judge who scored A
 * above B prefers A; equal scores say nothing) and fits Bradley–Terry to them. It never sees a
 * judge's level, so leniency cannot touch it. What it gives up is the size of every difference
 * and every tie.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fitOffsets, mean, type Observation } from '../src/domain/normalization.ts';
import { fitBradleyTerry, impliedComparisons } from '../src/domain/pairwise.ts';

interface Layout { pairs: { judge: string; project: string }[]; judges: string[]; projects: string[] }

function fixtureLayout(): Layout {
  const file = path.join(import.meta.dirname, '..', 'fixtures.json');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8')) as { scores: { judge: string; project: string }[] };
  const pairs = fixture.scores.filter((s) => s.project !== 'prj_07').map(({ judge, project }) => ({ judge, project }));
  return { pairs, judges: [...new Set(pairs.map((p) => p.judge))].sort(), projects: [...new Set(pairs.map((p) => p.project))].sort() };
}

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
const offsets: Method = (obs) => {
  const model = fitOffsets(obs, { lambda: 2 });
  return new Map([...model.projectEffect].map(([p, a]) => [p, model.mu + a]));
};
const withinJudge: Method = (obs) => fitBradleyTerry(impliedComparisons(obs)).theta;
/** The mean of the two ranks: offsets and within-judge, each rescaled to rank positions. */
const blend: Method = (obs) => {
  const toRanks = (m: Map<string, number>) => new Map([...m].sort((a, b) => b[1] - a[1]).map(([p], i) => [p, -i]));
  const a = toRanks(offsets(obs));
  const b = toRanks(withinJudge(obs));
  return new Map([...a].map(([p, r]) => [p, r + (b.get(p) ?? r)]));
};

function ranks(values: Map<string, number>): Map<string, number> {
  const sorted = [...values].sort((a, b) => b[1] - a[1]);
  return new Map(sorted.map(([p], i) => [p, i + 1]));
}
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
  ['raw mean', rawMean],
  ['offsets, lambda 2 (the ranking)', offsets],
  ['within-judge Bradley–Terry (the second opinion)', withinJudge],
  ['mean of the two ranks', blend],
];

interface Scenario { name: string; sdQ: number; sdB: number; sdE: number; spread: boolean }
const scenarios: Scenario[] = [
  { name: 'judges differ in bias only (SD 0.5)', sdQ: 0.7, sdB: 0.5, sdE: 0.8, spread: false },
  { name: 'judges differ in bias and in spread (x0.5 to x2)', sdQ: 0.7, sdB: 0.5, sdE: 0.8, spread: true },
  { name: 'strong bias (SD 0.8)', sdQ: 0.7, sdB: 0.8, sdE: 0.8, spread: false },
  { name: 'no bias at all (the null case)', sdQ: 0.7, sdB: 0, sdE: 0.8, spread: false },
];

const layout = fixtureLayout();
const RUNS = Number(process.env.RUNS ?? 300);
console.log(`Layout from fixtures.json: ${layout.pairs.length} reviews, ${layout.projects.length} projects, ${layout.judges.length} judges; ${RUNS} simulated events per scenario\n`);
for (const [s, scenario] of scenarios.entries()) {
  const random = rng(2026 + s);
  const totals = METHODS.map(() => ({ rho: 0, top: 0 }));
  for (let run = 0; run < RUNS; run++) {
    const quality = new Map(layout.projects.map((p) => [p, scenario.sdQ * normal(random)]));
    const bias = new Map(layout.judges.map((j) => [j, scenario.sdB * normal(random)]));
    const spread = new Map(layout.judges.map((j) => [j, scenario.spread ? Math.exp(Math.log(0.5) + random() * Math.log(4)) : 1]));
    const obs: Observation[] = layout.pairs.map(({ judge, project }) => ({
      judge,
      project,
      score: mean([0, 1, 2].map(() => Math.round(Math.min(5, Math.max(1, 3 + (spread.get(judge) ?? 1) * ((quality.get(project) ?? 0) + scenario.sdE * normal(random)) + (bias.get(judge) ?? 0)))))),
    }));
    METHODS.forEach(([, method], i) => {
      const estimate = method(obs);
      const total = totals[i];
      if (!total) return;
      total.rho += spearman(estimate, quality);
      total.top += topKRecall(estimate, quality);
    });
  }
  console.log(`Scenario: ${scenario.name}`);
  console.log('| Method | Rank correlation with truth | True top 5 found |');
  console.log('|---|---|---|');
  METHODS.forEach(([name], i) => {
    const t = totals[i];
    if (t) console.log(`| ${name} | ${(t.rho / RUNS).toFixed(3)} | ${((t.top / RUNS) * 100).toFixed(0)}% |`);
  });
  console.log('');
}
