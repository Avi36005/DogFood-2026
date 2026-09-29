import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { competitionRanks, fitOffsets, weightedScore, type Observation } from '../../src/domain/normalization.ts';
import { FIXTURES } from '../helpers.ts';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

describe('fitOffsets: hand-computed cases', () => {
  // Two judges, two projects, full matrix. Judge A is exactly one point more generous than B.
  //   A: p1=4, p2=3     B: p1=3, p2=2     mu = 3
  // By symmetry b_A = -b_B = b, so a_p = mean of p's scores - mu: a1 = +0.5, a2 = -0.5.
  // b_A = sum over A's reviews of (x - mu - a_p) / (n_A + lambda) = (0.5 + 0.5) / (2 + lambda).
  const full: Observation[] = [
    { judge: 'A', project: 'p1', score: 4 },
    { judge: 'A', project: 'p2', score: 3 },
    { judge: 'B', project: 'p1', score: 3 },
    { judge: 'B', project: 'p2', score: 2 },
  ];

  test('lambda = 2 shrinks the offsets to 1 / (2 + 2) = 0.25', () => {
    const model = fitOffsets(full, { lambda: 2 });
    close(model.mu, 3);
    close(model.judgeOffset.get('A'), 0.25);
    close(model.judgeOffset.get('B'), -0.25);
    close(model.projectEffect.get('p1'), 0.5);
    close(model.projectEffect.get('p2'), -0.5);
    assert.ok(model.converged);
  });

  test('lambda = 0 recovers the full one-point gap, centred on zero', () => {
    const model = fitOffsets(full, { lambda: 0 });
    close(model.judgeOffset.get('A'), 0.5);
    close(model.judgeOffset.get('B'), -0.5);
    close((model.judgeOffset.get('A') ?? 0) - (model.judgeOffset.get('B') ?? 0), 1);
  });

  // A harsh judge H and a fair judge F both see project C, which tells the model H is harsher.
  // P is seen only by H, Q only by F. Raw means put Q first; removing H's harshness moves P up.
  const bridged: Observation[] = [
    { judge: 'H', project: 'C', score: 3 },
    { judge: 'F', project: 'C', score: 4 },
    { judge: 'H', project: 'P', score: 4 },
    { judge: 'F', project: 'Q', score: 4.5 },
  ];

  test('without shrinkage, a harsh judge is fully corrected and the order flips', () => {
    const model = fitOffsets(bridged, { lambda: 0 });
    const p = model.mu + (model.projectEffect.get('P') ?? 0);
    const q = model.mu + (model.projectEffect.get('Q') ?? 0);
    close((model.judgeOffset.get('F') ?? 0) - (model.judgeOffset.get('H') ?? 0), 1);
    assert.ok(p > q, `P (${p}) should now beat Q (${q})`);
  });

  test('with shrinkage, the correction is partial but in the same direction', () => {
    const model = fitOffsets(bridged, { lambda: 2 });
    const p = model.mu + (model.projectEffect.get('P') ?? 0);
    const q = model.mu + (model.projectEffect.get('Q') ?? 0);
    assert.ok(p - q > 4 - 4.5, 'the gap between P and Q must narrow compared with raw means');
    assert.ok((model.judgeOffset.get('H') ?? 0) < 0 && (model.judgeOffset.get('F') ?? 0) > 0);
  });

  test('a judge with one review barely moves: the single-review overfit the plan warned about', () => {
    const obs: Observation[] = [
      { judge: 'J1', project: 'x', score: 2 },
      { judge: 'J2', project: 'x', score: 4 },
      { judge: 'J2', project: 'y', score: 4 },
      { judge: 'J3', project: 'y', score: 4 },
    ];
    const shrunk = Math.abs(fitOffsets(obs, { lambda: 2 }).judgeOffset.get('J1') ?? 0);
    const raw = Math.abs(fitOffsets(obs, { lambda: 0 }).judgeOffset.get('J1') ?? 0);
    assert.ok(shrunk < raw / 2, `shrunk ${shrunk} should be well under unshrunk ${raw}`);
  });

  test('a constant judge gets a finite offset instead of a division by zero', () => {
    const obs: Observation[] = [
      { judge: 'flat', project: 'a', score: 4 },
      { judge: 'flat', project: 'b', score: 4 },
      { judge: 'flat', project: 'c', score: 4 },
      { judge: 'other', project: 'a', score: 2 },
      { judge: 'other', project: 'b', score: 3 },
      { judge: 'other', project: 'c', score: 5 },
    ];
    const model = fitOffsets(obs);
    const offset = model.judgeOffset.get('flat') ?? Number.NaN;
    assert.ok(Number.isFinite(offset) && offset > 0, 'the flat judge scores above the other judge on average, so reads as generous');
    // The flat judge cannot change the order among a, b, c; the other judge decides it.
    const score = (p: string) => model.mu + (model.projectEffect.get(p) ?? 0);
    assert.ok(score('c') > score('b') && score('b') > score('a'));
  });

  test('is deterministic regardless of input order', () => {
    const shuffled = [...full].reverse();
    const a = fitOffsets(full);
    const b = fitOffsets(shuffled);
    assert.deepEqual([...a.projectEffect], [...b.projectEffect]);
    assert.deepEqual([...a.judgeOffset], [...b.judgeOffset]);
  });

  test('handles no data and refuses bad input', () => {
    const empty = fitOffsets([]);
    assert.equal(empty.projectEffect.size, 0);
    assert.ok(empty.converged);
    assert.throws(() => fitOffsets(full, { lambda: -1 }), RangeError);
    assert.throws(() => fitOffsets([{ judge: 'a', project: 'b', score: Number.NaN }]), RangeError);
  });
});

