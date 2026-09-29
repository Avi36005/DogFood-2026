import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { migrate } from '../../src/db/migrate.ts';
import { Store } from '../../src/db/store.ts';
import { getEvent } from '../../src/domain/events.ts';
import { importFixtures } from '../../src/domain/fixtures.ts';
import type { Observation } from '../../src/domain/normalization.ts';
import { computeStandings } from '../../src/domain/results.ts';
import { systemActor } from '../../src/domain/types.ts';
import { assessUncertainty, mulberry32, podiumStability, residualSigma, reviewsToSeparate } from '../../src/domain/uncertainty.ts';
import { FIXTURES } from '../helpers.ts';

/** Every judge scores every project; project p's true quality is quality[p]; judge j adds bias[j]. */
function panel(quality: Record<string, number>, bias: Record<string, number>, jitter = 0): Observation[] {
  const random = mulberry32(7);
  return Object.entries(bias).flatMap(([judge, b]) =>
    Object.entries(quality).map(([project, q]) => ({ judge, project, score: q + b + (random() - 0.5) * jitter })),
  );
}

describe('rank uncertainty', () => {
  test('a clear winner gets a one-place interval and is separated from second', () => {
    const obs = panel({ p1: 4.8, p2: 3.2, p3: 3.0, p4: 2.0 }, { A: 0, B: 0.3, C: -0.3, D: 0.1 }, 0.2);
    const u = assessUncertainty(obs, { lambda: 2, replicates: 200 });
    assert.deepEqual(u.intervals.get('p1'), { lo: 1, hi: 1, podiumShare: 1 });
    const first = u.separations[0];
    assert.equal(first?.above, 'p1');
    assert.equal(first?.separated, true);
    assert.equal(first?.reviewsEach, 0);
  });

  test('two identical projects are reported as a tie, whatever order the table shows', () => {
    const obs = panel({ p1: 4, p2: 4, p3: 2 }, { A: 0.4, B: -0.4, C: 0 }, 1.2);
    const u = assessUncertainty(obs, { lambda: 2, replicates: 300 });
    const pair = u.separations[0];
    assert.ok(pair && !pair.separated, 'places 1 and 2 are not separated');
    assert.ok(pair.orderShare > 0.2 && pair.orderShare < 0.8, `order kept ${pair.orderShare}`);
  });

  test('seeded: the same reviews give the same intervals, run after run', () => {
    const obs = panel({ p1: 4, p2: 3.8, p3: 3.1, p4: 2.5 }, { A: 0.2, B: -0.5, C: 0 }, 1);
    const a = assessUncertainty(obs, { lambda: 2, replicates: 100 });
    const b = assessUncertainty(obs, { lambda: 2, replicates: 100 });
    assert.deepEqual([...a.intervals], [...b.intervals]);
    assert.deepEqual(a.separations, b.separations);
  });

  test('leaving one judge out names the judge who alone decides first place', () => {
    // Everyone rates p1 and p2 level, except K, who loves p2 and is the only one to score p3 low.
    const obs: Observation[] = [
      ...panel({ p1: 4, p2: 4, p3: 3 }, { A: 0, B: 0, C: 0 }).map((o) => (o.project === 'p1' ? { ...o, score: 4.1 } : o)),
      { judge: 'K', project: 'p2', score: 5 },
      { judge: 'K', project: 'p1', score: 3 },
    ];
    const u = assessUncertainty(obs, { lambda: 2, replicates: 50 });
    assert.equal(u.stability.winner, 'p2');
    assert.equal(u.stability.refits, 4);
    assert.deepEqual(u.stability.influential.map((i) => [i.judge, i.winner, i.changesWinner]), [['K', 'p1', true]]);
    assert.equal(u.stability.winnerHolds, 3);
  });

  test('reviews needed to separate: worked by hand', () => {
    // 1.645 * sqrt(2 / (2 + m)) <= 1 first holds at m = 4 (m = 3 gives 1.04).
    assert.equal(reviewsToSeparate(1, 1, 2, 2), 4);
    assert.equal(reviewsToSeparate(3, 1, 2, 2), 0);
    assert.equal(reviewsToSeparate(0, 1, 2, 2), null, 'a zero gap is a tie at any sample size');
  });

  test('residual sigma: an exact fit has no noise; degrees of freedom inflate the RMS', () => {
    const obs = panel({ p1: 4, p2: 3 }, { A: 0, B: 0 });
    assert.equal(residualSigma(obs, obs.map(() => 0), 2), 0);
    // 4 reviews, 2 projects, 2 judges with 2 reviews each at lambda 2: df = 2 + 2 * 0.5 = 3.
    assert.ok(Math.abs(residualSigma(obs, [1, -1, 1, -1], 2) - Math.sqrt(4 / (4 - 3))) < 1e-12);
  });

  test('podiumStability without judges to remove reports zero refits', () => {
    assert.deepEqual(podiumStability([], 2, []), { refits: 0, winner: null, podium: [], winnerHolds: 0, podiumHolds: 0, influential: [] });
  });
});

describe('uncertainty on the DOGFOOD fixture: the numbers JUDGING.md quotes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-uncertainty-'));
  const store = new Store(path.join(dir, 'u.db'));
  migrate(store);
  importFixtures(store, systemActor(), JSON.parse(fs.readFileSync(FIXTURES, 'utf8')));
  const standings = computeStandings(store, getEvent(store, 'evt_01'), { uncertainty: true });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const u = standings.uncertainty;

  test('one review carries about 0.61 points of noise', () => {
    assert.ok(u && Math.abs(u.sigma - 0.607) < 0.0005, `sigma ${u?.sigma}`);
  });

  test('first place holds in 22 of 29 leave-one-judge-out refits; the podium in 23', () => {
    assert.equal(u?.stability.winner, 'prj_34');
    assert.equal(u?.stability.refits, 29);
    assert.equal(u?.stability.winnerHolds, 22);
    assert.equal(u?.stability.podiumHolds, 23);
    assert.ok(u?.stability.influential.some((i) => i.judge === 'jdg_07' && i.changesWinner), 'the flat judge jdg_07 decides first place');
  });

  test('no confident podium: every pair at the prize line is a statistical tie', () => {
    assert.equal(u?.separations.length, 3);
    for (const s of u?.separations ?? []) assert.equal(s.separated, false, `places ${s.place} and ${s.place + 1}`);
    const leader = standings.standings[0];
    assert.equal(leader?.project_id, 'prj_34');
    assert.equal(leader?.rank_lo, 1);
    assert.ok((leader?.rank_hi ?? 0) > 3, 'the leader could plausibly finish off the podium');
  });
});
