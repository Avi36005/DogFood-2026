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

describe('constraints carried by the schema', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
    migrate(store);
    importFixtures(store, systemActor(), fixture());
  });

  test('the audit log is append-only', () => {
    assert.throws(() => store.run('UPDATE audit_log SET summary = ?', ['rewritten']), /append-only/);
    assert.throws(() => store.run('DELETE FROM audit_log'), /append-only/);
  });

  test('project revisions are append-only', () => {
    assert.throws(() => store.run('DELETE FROM project_revisions'), /append-only/);
  });

  test('a score outside the event scale is rejected by the database', () => {
    const row = store.get<{ assignment_id: string; criterion_id: string }>('SELECT assignment_id, criterion_id FROM review_scores LIMIT 1');
    assert.throws(() => store.run('UPDATE review_scores SET value = 9 WHERE assignment_id = ? AND criterion_id = ?', [row?.assignment_id ?? '', row?.criterion_id ?? '']), /scale/);
  });

  test('a team cannot have two live projects', () => {
    assert.throws(() => store.run("UPDATE projects SET superseded_by = NULL WHERE id = 'prj_07'"), /UNIQUE/);
  });

  test('a project cannot point at another event’s track', () => {
    store.run("INSERT INTO events (id, slug, name, submissions_close_at, created_at, updated_at) VALUES ('evt_x', 'x', 'X', '2030-01-01T00:00:00.000Z', '', '')");
    store.run("INSERT INTO tracks (id, event_id, name) VALUES ('trk_x', 'evt_x', 'Other')");
    assert.throws(() => store.run("UPDATE projects SET track_id = 'trk_x' WHERE id = 'prj_01'"), /FOREIGN KEY/);
  });

  test('a judge cannot be assigned without holding the judge role in that event', () => {
    assert.throws(
      () => store.run("INSERT INTO assignments (id, event_id, project_id, judge_id, source, created_at) VALUES ('a1', 'evt_01', 'prj_01', 'usr_ecef4d6b84b1', 'manual', '')"),
      /FOREIGN KEY/,
    );
  });

  test('the same judge cannot be assigned the same project twice', () => {
    const existing = store.get<{ project_id: string; judge_id: string }>('SELECT project_id, judge_id FROM assignments LIMIT 1');
    assert.throws(
      () => store.run("INSERT INTO assignments (id, event_id, project_id, judge_id, source, created_at) VALUES ('a2', 'evt_01', ?, ?, 'manual', '')", [existing?.project_id ?? '', existing?.judge_id ?? '']),
      /UNIQUE/,
    );
  });

  test('a transaction that fails leaves nothing behind', () => {
    assert.throws(() => store.tx(() => {
      store.run("INSERT INTO settings (key, value) VALUES ('probe', '1')");
      throw new Error('boom');
    }), /boom/);
    assert.equal(store.get("SELECT 1 FROM settings WHERE key = 'probe'"), undefined);
  });
});

describe('judge flags on the fixture', () => {
  test('tell the planted constant judge apart from a judge whose totals happen to tie', () => {
    const store = new Store(':memory:');
    migrate(store);
    importFixtures(store, systemActor(), fixture());
    const judges = new Map(computeStandings(store, getEvent(store, 'evt_01')).judges.map((j) => [j.judge_id, j.flags]));
    assert.deepEqual(judges.get('jdg_07'), ['identical-scores'], '4/4/4 on every review');
    assert.deepEqual(judges.get('jdg_19'), ['same-total'], '(3,5,3), (3,4,4), (5,4,2): different criteria, equal totals');
    assert.equal(judges.has('jdg_01'), false, 'its only review was of the replaced duplicate');
  });
});
