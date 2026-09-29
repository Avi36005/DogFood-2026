import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { getEvent } from '../../src/domain/events.ts';
import { currentEvidence, verifyBundle, type Bundle, type ResultsDocument } from '../../src/domain/evidence.ts';
import { createSession } from '../../src/domain/sessions.ts';
import { signingKey, signText } from '../../src/domain/signing.ts';
import { migrate } from '../../src/db/migrate.ts';
import { Store } from '../../src/db/store.ts';
import { Client, FIXTURES, startServer } from '../helpers.ts';

/**
 * The fixture, swept end to end: every one of its 126 reviews, 30 judges and 41 projects gets its
 * own check through the HTTP interface, computed independently from fixtures.json rather than
 * read back from the code under test. Then the published, signed results are attacked one field
 * and one input at a time.
 */

interface FixtureScore { judge: string; project: string; criteria: Record<string, number>; comment: string }
interface FixtureData {
  judges: { id: string; name: string }[];
  projects: { id: string; title: string; team: string }[];
  scores: FixtureScore[];
}
const fixture = JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as FixtureData;
const S = 'sample-hack-2026';
/** prj_41 "Dry Harbour" resubmits prj_07 from the same team; the import keeps the later one. */
const DUPLICATE = 'prj_07';
const RANKED = fixture.projects.filter((p) => p.id !== DUPLICATE);
const KEPT_REVIEWS = fixture.scores.filter((s) => s.project !== DUPLICATE);

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries((header ?? []).map((h, i) => [h, r[i] ?? ''])));
}

describe('fixture sweep', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const sessions = new Map<string, string>();
  let weights = new Map<string, number>();
  let results: Record<string, string>[] = [];
  let reviewsCsv: Record<string, string>[] = [];
  let gallery = '';
  let superseded = new Set<string>();
  const as = (judge: string) => new Client(server.url, sessions.get(judge));

  before(async () => {
    server = await startServer();
    const store = server.booted.store;
    for (const judge of fixture.judges) sessions.set(judge.id, createSession(store, judge.id, new Date()));
    weights = new Map(store.all<{ key: string; weight: number }>("SELECT key, weight FROM criteria WHERE event_id = 'evt_01'").map((c) => [c.key, c.weight]));
    superseded = new Set(store.all<{ id: string }>("SELECT id FROM projects WHERE event_id = 'evt_01' AND superseded_by IS NOT NULL").map((r) => r.id));
    const organizer = Client.as(server.url, 'organizer');
    results = parseCsv((await organizer.get('/api/export.csv')).text);
    reviewsCsv = parseCsv((await organizer.get('/api/export.csv?event=evt_01&kind=reviews')).text);
    gallery = (await new Client(server.url).get('/projects')).text;
  });
  after(() => server.close());

  const weighted = (criteria: Record<string, number>) => {
    let total = 0;
    let sum = 0;
    for (const [key, weight] of weights) { total += weight * (criteria[key] as number); sum += weight; }
    return total / sum;
  };

  test('the import supersedes exactly the duplicate, prj_07', () => {
    assert.deepEqual([...superseded], [DUPLICATE]);
  });

  describe('every review reaches its own judge exactly as scored', () => {
    for (const s of fixture.scores) {
      test(`${s.judge} → ${s.project}: criteria and comment`, async () => {
        const reply = await as(s.judge).getJson('/api/judge/scores');
        assert.equal(reply.status, 200);
        const entry = reply.json<{ scores: { project_id: string; criteria: Record<string, number>; comment: string; status: string }[] }>().scores.find((e) => e.project_id === s.project);
        assert.ok(entry, `${s.project} missing from ${s.judge}'s scores`);
        assert.deepEqual(entry.criteria, s.criteria);
        assert.equal(entry.comment, s.comment);
        assert.equal(entry.status, 'submitted');
      });
    }
  });

  describe('every review appears once in the organizer reviews export, with its weighted total', () => {
    for (const s of fixture.scores) {
      test(`${s.judge} → ${s.project}: one row, same values`, () => {
        const rows = reviewsCsv.filter((r) => r.judge_id === s.judge && r.project_id === s.project);
        assert.equal(rows.length, 1);
        const row = rows[0] as Record<string, string>;
        for (const [key, value] of Object.entries(s.criteria)) assert.equal(Number(row[key]), value, key);
        assert.ok(Math.abs(Number(row.weighted) - weighted(s.criteria)) < 5e-4, `weighted ${row.weighted}`);
        assert.equal(row.comment, s.comment);
      });
    }
  });

  describe('every judge sees exactly their own reviews', () => {
    for (const judge of fixture.judges) {
      test(`${judge.id} lists exactly the fixture's reviews by ${judge.id}`, async () => {
        const reply = await as(judge.id).getJson('/api/judge/scores');
        assert.equal(reply.status, 200);
        const body = reply.json<{ judge: { id: string }; scores: { project_id: string }[] }>();
        assert.equal(body.judge.id, judge.id);
        const mine = fixture.scores.filter((s) => s.judge === judge.id).map((s) => s.project).sort();
        assert.deepEqual(body.scores.map((e) => e.project_id).sort(), mine);
      });
    }
  });

  describe("no judge can read another judge's scores", () => {
    for (const judge of fixture.judges) {
      test(`${judge.id} is refused all 29 other judges, and each refusal is audited`, async () => {
        const store = server.booted.store;
        const before = store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'access.denied' AND actor_id = ?", [judge.id])?.n ?? 0;
        for (const peer of fixture.judges.filter((j) => j.id !== judge.id)) {
          const reply = await as(judge.id).getJson(`/api/judge/scores?judge=${peer.id}`);
          assert.equal(reply.status, 403, `${judge.id} reading ${peer.id}`);
          assert.doesNotMatch(reply.text, /"criteria"/);
        }
        const afterCount = store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'access.denied' AND actor_id = ?", [judge.id])?.n ?? 0;
        assert.equal(afterCount - before, fixture.judges.length - 1);
      });
    }
  });

  describe('every project: public page, gallery and nothing about its reviews', () => {
    const names = fixture.judges.map((j) => j.name);
    for (const project of fixture.projects) {
      test(`${project.id} "${project.title}"`, async () => {
        const page = await new Client(server.url).get(`/projects/${project.id}`);
        if (superseded.has(project.id)) {
          assert.equal(page.status, 404, 'a superseded duplicate is not public');
          assert.doesNotMatch(gallery, new RegExp(`href="/projects/${project.id}"`));
          return;
        }
        assert.equal(page.status, 200);
        assert.ok(page.text.includes(project.title.replace(/'/g, '&#39;')), 'title on its page');
        assert.match(gallery, new RegExp(`href="/projects/${project.id}"`), 'linked from the gallery');
        for (const name of names) assert.ok(!page.text.includes(name), `judge name ${name} leaked`);
        assert.doesNotMatch(page.text, /jdg_\d\d|Runs clean\.|Docs are thin\./);
      });
    }
  });

  describe('every project: its results row matches an independent recomputation from fixtures.json', () => {
    for (const project of fixture.projects) {
      test(`${project.id}: raw mean and review count`, () => {
        const row = results.find((r) => r.project_id === project.id);
        if (superseded.has(project.id)) {
          assert.equal(row, undefined, 'a superseded duplicate is not ranked');
          return;
        }
        assert.ok(row, `${project.id} missing from the results export`);
        const reviews = fixture.scores.filter((s) => s.project === project.id);
        assert.equal(Number(row.reviews), reviews.length);
        const raw = reviews.reduce((sum, s) => sum + weighted(s.criteria), 0) / reviews.length;
        assert.ok(Math.abs(Number(row.raw_mean) - raw) < 5e-4, `raw mean ${row.raw_mean} vs ${raw}`);
        const lo = Number(row.rank_lo_90);
        const hi = Number(row.rank_hi_90);
        assert.ok(lo <= Number(row.rank) && Number(row.rank) <= hi, `rank ${row.rank} inside [${lo}, ${hi}]`);
      });
    }
  });

  describe('every project: rank order agrees with the normalized scores', () => {
    for (const project of RANKED) {
      test(`${project.id}: exactly the projects scoring clearly higher rank above it`, () => {
        const row = results.find((r) => r.project_id === project.id);
        assert.ok(row, `${project.id} missing from the results export`);
        const score = Number(row.normalized_score);
        const higher = results.filter((r) => Number(r.normalized_score) > score + 1e-3).length;
        const tiedOrHigher = results.filter((r) => Number(r.normalized_score) > score - 1e-3).length;
        assert.ok(Number(row.rank) >= higher + 1 && Number(row.rank) <= tiedOrHigher, `rank ${row.rank}, ${higher} above`);
      });
    }
  });

  describe('signed results: any change is caught', () => {
    let bundle: Bundle;
    let doc: ResultsDocument;
    let forger: ReturnType<typeof signingKey>;

    before(async () => {
      const organizer = Client.as(server.url, 'organizer');
      const store = server.booted.store;
      store.run("UPDATE events SET submissions_close_at = '2000-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
      const published = await organizer.request('POST', `/organize/${S}/results/publish`, { body: '{}', type: 'application/json', headers: { accept: 'application/json' } });
      assert.equal(published.status, 200, published.text.slice(0, 200));
      const evidence = currentEvidence(store, getEvent(store, 'evt_01'));
      assert.ok(evidence);
      bundle = { document_text: evidence.documentText, signature: evidence.signature, public_key: evidence.publicKey, inputs: evidence.inputs };
      doc = JSON.parse(evidence.documentText) as ResultsDocument;
      const other = new Store(':memory:'); // a stranger's instance, with its own signing key
      migrate(other);
      forger = signingKey(other);
    });

    test('the published bundle verifies: signature, inputs fingerprint and refit', () => {
      assert.deepEqual(verifyBundle(bundle), { signature: true, fingerprint: true, refit: true, problems: [] });
    });

    test('the public results.json carries the same signed text', async () => {
      const reply = await new Client(server.url).getJson(`/events/${S}/results.json`);
      assert.equal(reply.status, 200);
      const body = reply.json<{ document_text: string; signature: string }>();
      assert.equal(body.document_text, bundle.document_text);
      assert.equal(body.signature, bundle.signature);
    });

    const edit = (mutate: (d: ResultsDocument) => void): string => {
      const copy = JSON.parse(bundle.document_text) as ResultsDocument;
      mutate(copy);
      return JSON.stringify(copy);
    };

    test('the signed ranking has one entry per ranked project', () => {
      assert.deepEqual(doc.ranking.map((e) => e.project).sort(), RANKED.map((p) => p.id).sort());
    });

    for (const [i, project] of RANKED.entries()) {
      test(`${project.id}: nudging its signed score breaks the signature`, () => {
        const text = edit((d) => { (d.ranking.find((e) => e.project === project.id) as { score: number }).score += 0.001; });
        assert.notEqual(text, bundle.document_text, `entry ${i + 1} was edited`);
        assert.equal(verifyBundle({ ...bundle, document_text: text }).signature, false);
      });
    }

    for (const project of RANKED) {
      test(`${project.id}: a forger who re-signs a promoted score is caught by the refit`, () => {
        const text = edit((d) => {
          const entry = d.ranking.find((e) => e.project === project.id) as { score: number; rank: number };
          entry.score += 0.5;
          entry.rank = 1;
        });
        const report = verifyBundle({ ...bundle, document_text: text, signature: signText(forger, text), public_key: forger.publicKey });
        assert.equal(report.signature, true, 'the forger signs with their own key');
        assert.equal(report.refit, false, 'but the inputs do not reproduce the ranking');
      });
    }

    test('every input row gets its own tamper check below', () => {
      assert.equal(bundle.inputs?.length, doc.inputs.reviews);
      assert.equal(doc.inputs.reviews, KEPT_REVIEWS.length);
    });

    for (let i = 0; i < KEPT_REVIEWS.length; i++) {
      test(`input ${i + 1} of ${KEPT_REVIEWS.length}: changing that one review score fails the fingerprint`, () => {
        const inputs = bundle.inputs ?? [];
        assert.ok(inputs[i], `input ${i + 1} exists`);
        const changed = inputs.map((row, k) => (k === i ? ([row[0], row[1], row[2] >= 4.5 ? row[2] - 1 : row[2] + 1] as typeof row) : row));
        const report = verifyBundle({ ...bundle, inputs: changed });
        assert.equal(report.signature, true);
        assert.equal(report.fingerprint, false);
      });
    }
  });
});
