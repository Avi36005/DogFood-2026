import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { migrate } from '../../src/db/migrate.ts';
import { Store } from '../../src/db/store.ts';
import { pairwiseSummary } from '../../src/domain/compare.ts';
import { getEvent } from '../../src/domain/events.ts';
import { importFixtures } from '../../src/domain/fixtures.ts';
import { fitBradleyTerry, impliedComparisons, nextPair, orderByStrength, pairKey, spearman, winProbability, type Comparison } from '../../src/domain/pairwise.ts';
import { systemActor } from '../../src/domain/types.ts';
import { mulberry32 } from '../../src/domain/uncertainty.ts';
import { FIXTURES } from '../helpers.ts';

const games = (winner: string, loser: string, n: number, judge = 'J'): Comparison[] => Array.from({ length: n }, () => ({ judge, winner, loser }));

describe('Bradley–Terry fit', () => {
  test('two projects, 3 wins to 1: the prior keeps it finite, and the stronger one is ahead', () => {
    // Each project also plays one virtual win and one virtual loss against a reference of
    // strength 1. Check both strengths satisfy the MM fixed point exactly.
    const fit = fitBradleyTerry([...games('A', 'B', 3), ...games('B', 'A', 1)]);
    const a = Math.exp(fit.theta.get('A') as number);
    const b = Math.exp(fit.theta.get('B') as number);
    assert.ok(fit.converged);
    assert.ok(Math.abs(a - (3 + 1) / (4 / (a + b) + 2 / (a + 1))) < 1e-9, 'A satisfies the MM fixed point');
    assert.ok(Math.abs(b - (1 + 1) / (4 / (a + b) + 2 / (b + 1))) < 1e-9, 'B satisfies the MM fixed point');
    assert.ok(winProbability(fit, 'A', 'B') > 0.5 && winProbability(fit, 'A', 'B') < 0.75, 'shrunk toward even by the prior');
  });

  test('an unbeaten project stays finite, and more evidence moves it further', () => {
    const one = fitBradleyTerry(games('A', 'B', 1));
    const five = fitBradleyTerry(games('A', 'B', 5));
    assert.ok(Number.isFinite(one.theta.get('A') as number));
    assert.ok((five.theta.get('A') as number) > (one.theta.get('A') as number));
  });

  test('recovers a known order from simulated comparisons', () => {
    const truth = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const strength = new Map(truth.map((p, i) => [p, 2 - i * 0.6]));
    const random = mulberry32(11);
    const comparisons: Comparison[] = [];
    for (let k = 0; k < 600; k++) {
      const a = truth[Math.floor(random() * truth.length)] as string;
      const b = truth[Math.floor(random() * truth.length)] as string;
      if (a === b) continue;
      const pa = 1 / (1 + Math.exp((strength.get(b) as number) - (strength.get(a) as number)));
      comparisons.push(random() < pa ? { judge: 'J', winner: a, loser: b } : { judge: 'J', winner: b, loser: a });
    }
    assert.deepEqual(orderByStrength(fitBradleyTerry(comparisons)), truth);
  });

  test('implied comparisons: each pair of one judge’s differing scores, and ties say nothing', () => {
    const implied = impliedComparisons([
      { judge: 'J1', project: 'a', score: 4 },
      { judge: 'J1', project: 'b', score: 3 },
      { judge: 'J1', project: 'c', score: 3 },
      { judge: 'FLAT', project: 'a', score: 4 },
      { judge: 'FLAT', project: 'b', score: 4 },
    ]);
    assert.deepEqual(implied, [
      { judge: 'J1', winner: 'a', loser: 'b' },
      { judge: 'J1', winner: 'a', loser: 'c' },
    ]);
  });

  test('Spearman: identical orders give 1, reversed give −1', () => {
    assert.equal(spearman(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']).rho, 1);
    assert.equal(spearman(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']).rho, -1);
  });

  test('next pair: never one already compared, then the least compared, then the closest', () => {
    const fit = fitBradleyTerry([...games('a', 'b', 4), ...games('c', 'b', 1)]);
    const counts = new Map([[pairKey('a', 'b'), 4], [pairKey('b', 'c'), 1]]);
    assert.deepEqual(nextPair(['a', 'b', 'c'], new Set(), counts, fit), ['a', 'c'], 'a–c has never been compared');
    assert.deepEqual(nextPair(['a', 'b', 'c'], new Set([pairKey('a', 'c')]), counts, fit), ['b', 'c']);
    assert.equal(nextPair(['a', 'b'], new Set([pairKey('a', 'b')]), counts, fit), null);
  });
});

describe('the pairwise second opinion on the DOGFOOD fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-pairwise-'));
  const store = new Store(path.join(dir, 'p.db'));
  migrate(store);
  importFixtures(store, systemActor(), JSON.parse(fs.readFileSync(FIXTURES, 'utf8')));
  const summary = pairwiseSummary(store, getEvent(store, 'evt_01'));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });

  test('239 comparisons implied by the reviews; the flat judges imply none', () => {
    assert.equal(summary?.implied, 239);
    assert.equal(summary?.explicit, 0);
    assert.equal(summary?.fit.theta.size, 40);
  });

  test('it agrees with the rubric ranking (ρ ≈ 0.87) and puts Iron Switch first, unbeaten', () => {
    assert.ok(summary && Math.abs(summary.agreement.rho - 0.873) < 0.001, `rho ${summary?.agreement.rho}`);
    assert.equal(summary?.sameWinner, true);
    assert.deepEqual([summary?.order[0]?.title, summary?.order[0]?.wins, summary?.order[0]?.losses], ['Iron Switch', 16, 0]);
  });
});
