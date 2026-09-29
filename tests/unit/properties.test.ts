import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { migrate } from '../../src/db/migrate.ts';
import { Store } from '../../src/db/store.ts';
import { record, verifyChain } from '../../src/domain/audit.ts';
import { fitOffsets, type Observation, type OffsetModel } from '../../src/domain/normalization.ts';
import { fitBradleyTerry, impliedComparisons, orderByStrength, winProbability, type Comparison } from '../../src/domain/pairwise.ts';
import { systemActor } from '../../src/domain/types.ts';
import { mulberry32 } from '../../src/domain/uncertainty.ts';

/**
 * Properties that must hold for any event, not just the fixture: each seed draws a different
 * judge-project layout, bias pattern and score set, and every property is checked on every seed.
 * A seed that fails is printed in the test name, so it reproduces with one number.
 */

const SEEDS = Array.from({ length: 25 }, (_, i) => 1000 + i * 7919);
const CLOSE = 1e-7;

interface Design {
  observations: Observation[];
  judges: string[];
  projects: string[];
}

/** A random event: 8–40 projects, 5–30 judges, 2–5 reviews per project, integer scores 1–5 with judge bias. */
function design(seed: number): Design {
  const rand = mulberry32(seed);
  const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const projects = Array.from({ length: pick(8, 40) }, (_, i) => `p${String(i).padStart(2, '0')}`);
  const judges = Array.from({ length: pick(5, 30) }, (_, i) => `j${String(i).padStart(2, '0')}`);
  const quality = new Map(projects.map((p) => [p, rand() * 2 - 1]));
  const bias = new Map(judges.map((j) => [j, rand() * 1.6 - 0.8]));
  const observations: Observation[] = [];
  for (const project of projects) {
    const panel = [...judges].sort(() => rand() - 0.5).slice(0, pick(2, Math.min(5, judges.length)));
    for (const judge of panel) {
      const raw = 3 + (quality.get(project) as number) + (bias.get(judge) as number) + (rand() - 0.5);
      observations.push({ judge, project, score: Math.max(1, Math.min(5, Math.round(raw))) });
    }
  }
  return { observations, judges: [...new Set(observations.map((o) => o.judge))], projects };
}

const shuffled = <T>(items: readonly T[], seed: number): T[] => {
  const rand = mulberry32(seed);
  return [...items].map((item) => ({ item, key: rand() })).sort((a, b) => a.key - b.key).map((x) => x.item);
};

const fitted = (model: OffsetModel, o: Observation) => model.mu + (model.projectEffect.get(o.project) as number) + (model.judgeOffset.get(o.judge) as number);

function assertSameModel(a: OffsetModel, b: OffsetModel, map: (id: string) => string = (id) => id): void {
  assert.ok(Math.abs(a.mu - b.mu) < CLOSE, `mu ${a.mu} vs ${b.mu}`);
  for (const [p, v] of a.projectEffect) assert.ok(Math.abs(v - (b.projectEffect.get(map(p)) as number)) < CLOSE, `project ${p}`);
  for (const [j, v] of a.judgeOffset) assert.ok(Math.abs(v - (b.judgeOffset.get(map(j)) as number)) < CLOSE, `judge ${j}`);
}

describe('normalization properties on random events', () => {
  for (const seed of SEEDS) {
    const { observations } = design(seed);
    const lambda = 2;
    const model = fitOffsets(observations, { lambda });

    test(`seed ${seed}: the fit solves its normal equations (project residuals sum to 0, judge residuals to λ·offset)`, () => {
      assert.equal(model.converged, true);
      const byProject = new Map<string, number>();
      const byJudge = new Map<string, number>();
      for (const o of observations) {
        const r = o.score - fitted(model, o);
        byProject.set(o.project, (byProject.get(o.project) ?? 0) + r);
        byJudge.set(o.judge, (byJudge.get(o.judge) ?? 0) + r);
      }
      for (const [p, sum] of byProject) assert.ok(Math.abs(sum) < 1e-8, `project ${p}: ${sum}`);
      for (const [j, sum] of byJudge) assert.ok(Math.abs(sum - lambda * (model.judgeOffset.get(j) as number)) < 1e-8, `judge ${j}: ${sum}`);
    });

    test(`seed ${seed}: adding a constant to every score moves only the mean`, () => {
      const moved = fitOffsets(observations.map((o) => ({ ...o, score: o.score + 1.75 })), { lambda });
      assert.ok(Math.abs(moved.mu - model.mu - 1.75) < CLOSE);
      assertSameModel({ ...model, mu: moved.mu }, moved);
    });

    test(`seed ${seed}: rescaling every score rescales the mean and every effect by the same factor`, () => {
      const scaled = fitOffsets(observations.map((o) => ({ ...o, score: o.score * 2.5 })), { lambda });
      assert.ok(Math.abs(scaled.mu - model.mu * 2.5) < CLOSE);
      for (const [p, v] of model.projectEffect) assert.ok(Math.abs((scaled.projectEffect.get(p) as number) - v * 2.5) < 1e-6, `project ${p}`);
      for (const [j, v] of model.judgeOffset) assert.ok(Math.abs((scaled.judgeOffset.get(j) as number) - v * 2.5) < 1e-6, `judge ${j}`);
    });

    test(`seed ${seed}: the order reviews arrive in does not change the result`, () => {
      assertSameModel(model, fitOffsets(shuffled(observations, seed), { lambda }));
    });

    test(`seed ${seed}: renaming judges does not change anyone's score`, () => {
      const rename = (j: string) => `renamed_${j.split('').reverse().join('')}`;
      const renamed = fitOffsets(observations.map((o) => ({ ...o, judge: rename(o.judge) })), { lambda });
      assertSameModel(model, renamed, (id) => (id.startsWith('j') ? rename(id) : id));
    });

    test(`seed ${seed}: more shrinkage never makes judge offsets larger overall`, () => {
      const size = (m: OffsetModel) => [...m.judgeOffset.values()].reduce((s, b) => s + b * b, 0);
      const sizes = [0.5, 2, 8, 32].map((l) => size(fitOffsets(observations, { lambda: l })));
      for (let i = 1; i < sizes.length; i++) assert.ok((sizes[i] as number) <= (sizes[i - 1] as number) + 1e-12, `λ step ${i}: ${sizes.join(', ')}`);
    });
  }
});

describe('Bradley–Terry properties on random comparisons', () => {
  for (const seed of SEEDS.slice(0, 15)) {
    const { observations } = design(seed);
    const comparisons = impliedComparisons(observations);
    const fit = fitBradleyTerry(comparisons);

    test(`seed ${seed}: implied comparisons come only from one judge's own unequal scores`, () => {
      const score = new Map(observations.map((o) => [`${o.judge}|${o.project}`, o.score]));
      let expected = 0;
      const byJudge = new Map<string, number[]>();
      for (const o of observations) byJudge.set(o.judge, [...(byJudge.get(o.judge) ?? []), o.score]);
      for (const scores of byJudge.values()) for (let i = 0; i < scores.length; i++) for (let k = i + 1; k < scores.length; k++) if (scores[i] !== scores[k]) expected++;
      assert.equal(comparisons.length, expected);
      for (const c of comparisons) assert.ok((score.get(`${c.judge}|${c.winner}`) as number) > (score.get(`${c.judge}|${c.loser}`) as number));
    });

    test(`seed ${seed}: the fit converges and keeps every game`, () => {
      assert.equal(fit.converged, true);
      const wins = [...fit.wins.values()].reduce((s, n) => s + n, 0);
      const losses = [...fit.losses.values()].reduce((s, n) => s + n, 0);
      assert.equal(wins, comparisons.length);
      assert.equal(losses, comparisons.length);
    });

    test(`seed ${seed}: win probabilities are proper (P(a>b) + P(b>a) = 1, strictly between 0 and 1)`, () => {
      const items = [...fit.theta.keys()];
      for (const a of items) {
        for (const b of items) {
          const p = winProbability(fit, a, b);
          assert.ok(p > 0 && p < 1);
          assert.ok(Math.abs(p + winProbability(fit, b, a) - 1) < 1e-12);
        }
      }
    });

    test(`seed ${seed}: the order comparisons arrive in does not change the strengths`, () => {
      const again = fitBradleyTerry(shuffled(comparisons, seed));
      for (const [i, t] of fit.theta) assert.ok(Math.abs(t - (again.theta.get(i) as number)) < 1e-6, i);
    });

    test(`seed ${seed}: reversing every outcome mirrors every strength`, () => {
      const mirrored = fitBradleyTerry(comparisons.map((c): Comparison => ({ judge: c.judge, winner: c.loser, loser: c.winner })));
      for (const [i, t] of fit.theta) assert.ok(Math.abs(t + (mirrored.theta.get(i) as number)) < 1e-6, i);
    });

    test(`seed ${seed}: a project that wins every one of its comparisons ranks first`, () => {
      const others = [...fit.theta.keys()];
      const planted = [...comparisons, ...others.flatMap((o) => [0, 1, 2].map((): Comparison => ({ judge: 'planted', winner: 'champion', loser: o })))];
      assert.equal(orderByStrength(fitBradleyTerry(planted))[0], 'champion');
    });
  }
});

describe('the audit chain catches any single edit or removal', () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const ENTRIES = 24;
  function chain(): Store {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-chain-'));
    dirs.push(dir);
    const store = new Store(path.join(dir, 'c.db'));
    migrate(store);
    for (let n = 1; n <= ENTRIES; n++) record(store, systemActor(), { action: 'test.note', summary: `entry ${n}`, detail: { n } });
    return store;
  }
  const ids = (store: Store) => store.all<{ id: number }>('SELECT id FROM audit_log ORDER BY id').map((r) => r.id);

  test('an untouched chain of 24 entries verifies', () => {
    const report = verifyChain(chain());
    assert.equal(report.ok, true);
    assert.equal(report.verified, ENTRIES);
  });

  for (let position = 0; position < ENTRIES; position++) {
    test(`editing entry ${position + 1} of ${ENTRIES} is pinned to that entry`, () => {
      const store = chain();
      const id = ids(store)[position] as number;
      store.exec('DROP TRIGGER audit_log_no_update');
      store.run("UPDATE audit_log SET summary = summary || ' (edited)' WHERE id = ?", [id]);
      assert.equal(verifyChain(store).broken?.id, id);
    });
  }

  for (let position = 0; position < ENTRIES - 1; position++) {
    test(`removing entry ${position + 1} of ${ENTRIES} breaks the link of the next one`, () => {
      const store = chain();
      const all = ids(store);
      store.exec('DROP TRIGGER audit_log_no_delete');
      store.run('DELETE FROM audit_log WHERE id = ?', [all[position] as number]);
      const report = verifyChain(store);
      assert.equal(report.ok, false);
      assert.equal(report.broken?.id, all[position + 1]);
    });
  }
});
