import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { migrate } from '../../src/db/migrate.ts';
import { Store } from '../../src/db/store.ts';
import { getEvent } from '../../src/domain/events.ts';
import { FixtureError, importFixtures } from '../../src/domain/fixtures.ts';
import { computeStandings } from '../../src/domain/results.ts';
import { systemActor } from '../../src/domain/types.ts';
import { FIXTURES } from '../helpers.ts';

const fixture = () => JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as Record<string, any>;
const count = (store: Store, sql: string) => store.get<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`)?.n;

describe('fixture import', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
    migrate(store);
  });

  test('loads every record of the official file', () => {
    const report = importFixtures(store, systemActor(), fixture());
    assert.deepEqual(report.counts, { tracks: 8, criteria: 3, judges: 30, teams: 40, people: 91, projects: 41, scores: 126 });
    assert.equal(count(store, 'events'), 1);
    assert.equal(count(store, "reviews WHERE status = 'submitted'"), 126);
    assert.equal(count(store, 'review_scores'), 378);
    assert.equal(count(store, "event_roles WHERE role = 'judge'"), 30);
    assert.equal(count(store, "event_roles WHERE role = 'participant'"), 91);
  });

  test('keeps the fixture ids, so exports trace back to the file', () => {
    importFixtures(store, systemActor(), fixture());
    assert.ok(store.get("SELECT 1 FROM projects WHERE id = 'prj_01' AND title = 'Glass Signal'"));
    assert.ok(store.get("SELECT 1 FROM users WHERE id = 'jdg_24' AND email = 'diego.herrera@example.org'"));
    assert.equal(store.get<{ c: string }>("SELECT submissions_close_at AS c FROM events WHERE id = 'evt_01'")?.c, '2026-03-01T18:00:00.000Z');
  });

  test('applies the duplicate policy: the latest submission counts, the earlier one is kept as replaced', () => {
    const report = importFixtures(store, systemActor(), fixture());
    assert.deepEqual(report.duplicates, [{ team: 'tm_07', kept: 'prj_41', replaced: ['prj_07'] }]);
    assert.equal(store.get<{ s: string }>("SELECT superseded_by AS s FROM projects WHERE id = 'prj_07'")?.s, 'prj_41');
    assert.equal(store.get<{ s: string | null }>("SELECT superseded_by AS s FROM projects WHERE id = 'prj_41'")?.s, null);
    assert.equal(count(store, "assignments WHERE project_id = 'prj_07'"), 5, 'the replaced project keeps its reviews');
    assert.ok(store.get("SELECT 1 FROM audit_log WHERE action = 'project.duplicate_detected'"));
  });

  test('reports teams that share a name instead of refusing them', () => {
    const report = importFixtures(store, systemActor(), fixture());
    assert.equal(report.warnings.filter((w) => w.includes('share a name')).length, 3);
  });

  test('is idempotent: importing again changes nothing', () => {
    importFixtures(store, systemActor(), fixture());
    const again = importFixtures(store, systemActor(), fixture());
    assert.equal(again.skipped, true);
    assert.equal(count(store, 'projects'), 41);
    assert.equal(count(store, 'assignments'), 126);
  });

  test('refuses a file with broken references, and writes nothing', () => {
    const bad = fixture();
    bad.projects[0].team = 'tm_missing';
    bad.scores[0].criteria.quality = 9;
    bad.scores.push({ ...bad.scores[1] });
    assert.throws(() => importFixtures(store, systemActor(), bad), (error: unknown) => {
      assert.ok(error instanceof FixtureError);
      assert.ok(error.problems.some((p) => p.includes('unknown team tm_missing')));
      assert.ok(error.problems.some((p) => p.includes('integer from 1 to 5')));
      assert.ok(error.problems.some((p) => p.includes('scored') && p.includes('twice')));
      return true;
    });
    assert.equal(count(store, 'events'), 0);
    assert.equal(count(store, 'users'), 0);
  });

  test('refuses a judge who is also on a team', () => {
    const bad = fixture();
    bad.teams[0].members.push(bad.judges[0].email);
    assert.throws(() => importFixtures(store, systemActor(), bad), /also on team/);
  });
});

