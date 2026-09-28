import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertJudgingOpen, assertSubmissionsOpen, phaseOf } from '../../src/domain/events.ts';
import type { EventRow } from '../../src/domain/types.ts';
import { HttpError } from '../../src/util/errors.ts';

const event = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: 'evt', slug: 'evt', name: 'Test Hack', tagline: '', description: '',
  submissions_open_at: '2026-03-01T09:00:00.000Z',
  submissions_close_at: '2026-03-01T18:00:00.000Z',
  judging_close_at: null, results_published_at: null,
  max_team_size: 4, reviews_per_project: 3, score_min: 1, score_max: 5,
  source: 'created', created_by: null, created_at: '', updated_at: '',
  ...overrides,
});

const at = (instant: string) => new Date(instant);
const refused = (fn: () => void, pattern: RegExp) =>
  assert.throws(fn, (error: unknown) => error instanceof HttpError && error.status === 403 && pattern.test(error.message));

describe('the submission deadline', () => {
  test('is open one millisecond before the close', () => {
    assert.doesNotThrow(() => assertSubmissionsOpen(event(), at('2026-03-01T17:59:59.999Z')));
  });

  test('is closed at the close instant exactly (the boundary is exclusive)', () => {
    refused(() => assertSubmissionsOpen(event(), at('2026-03-01T18:00:00.000Z')), /closed on 1 Mar 2026, 18:00 UTC/);
  });

  test('is closed after the close', () => {
    refused(() => assertSubmissionsOpen(event(), at('2026-03-02T00:00:00Z')), /closed/);
  });

  test('is not yet open before the opening time', () => {
    refused(() => assertSubmissionsOpen(event(), at('2026-03-01T08:59:59Z')), /open on 1 Mar 2026, 09:00 UTC/);
  });

  test('an event with no opening time is open from creation', () => {
    assert.doesNotThrow(() => assertSubmissionsOpen(event({ submissions_open_at: null }), at('2020-01-01T00:00:00Z')));
  });
});

describe('phases', () => {
  test('move from upcoming to open to judging to published', () => {
    const e = event();
    assert.equal(phaseOf(e, at('2026-03-01T08:00:00Z')).key, 'upcoming');
    assert.equal(phaseOf(e, at('2026-03-01T12:00:00Z')).key, 'open');
    assert.equal(phaseOf(e, at('2026-03-01T18:00:00Z')).key, 'judging');
    assert.equal(phaseOf({ ...e, judging_close_at: '2026-03-05T00:00:00.000Z' }, at('2026-03-06T00:00:00Z')).key, 'judging-closed');
    assert.equal(phaseOf({ ...e, results_published_at: '2026-03-06T00:00:00.000Z' }, at('2026-03-06T00:00:00Z')).key, 'published');
  });

  test('judging is only open between the deadline and publication', () => {
    const e = event();
    refused(() => assertJudgingOpen(e, at('2026-03-01T12:00:00Z')), /starts when submissions close/);
    assert.doesNotThrow(() => assertJudgingOpen(e, at('2026-03-01T18:00:00Z')));
    refused(() => assertJudgingOpen({ ...e, results_published_at: '2026-03-02T00:00:00Z' }, at('2026-03-03T00:00:00Z')), /final/);
  });
});
