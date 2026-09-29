import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate } from '../../src/db/migrate.ts';
import { Store } from '../../src/db/store.ts';
import type { Certificate, JudgeRecord, SignedRecord } from '../../src/domain/records.ts';
import { createSession } from '../../src/domain/sessions.ts';
import { signingKey, signText, verifyText } from '../../src/domain/signing.ts';
import { Client, FIXTURES, startServer } from '../helpers.ts';

/**
 * T4 verifiable records: a signed certificate for every ranked project and a signed record for
 * every judge, each checked against fixtures.json and the signed results, then attacked.
 */

interface FixtureData {
  judges: { id: string }[];
  projects: { id: string; title: string }[];
  scores: { judge: string; project: string; criteria: Record<string, number> }[];
}
const fixture = JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as FixtureData;
const S = 'sample-hack-2026';
const DUPLICATE = 'prj_07';
const RANKED = fixture.projects.filter((p) => p.id !== DUPLICATE);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

describe('verifiable records (T4)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let organizer: Client;
  let resultsText = '';
  let ranks = new Map<string, number>();
  const sessions = new Map<string, string>();
  const as = (judge: string) => new Client(server.url, sessions.get(judge));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-records-'));

  before(async () => {
    server = await startServer();
    organizer = Client.as(server.url, 'organizer');
    for (const judge of fixture.judges) sessions.set(judge.id, createSession(server.booted.store, judge.id, new Date()));
  });
  after(async () => {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('before publication there is no certificate, and a judge record carries no results yet', async () => {
    assert.equal((await new Client(server.url).getJson(`/events/${S}/certificates/prj_01/signed.json`)).status, 404);
    const record = (await as('jdg_24').getJson(`/judge/${S}/record.json`)).json<SignedRecord>();
    assert.equal((JSON.parse(record.document_text) as JudgeRecord).results, null);
    assert.equal(verifyText(record.document_text, record.signature, record.public_key), true);
  });

  test('publish the results', async () => {
    server.booted.store.run("UPDATE events SET submissions_close_at = '2000-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
    const published = await organizer.request('POST', `/organize/${S}/results/publish`, { body: '{}', type: 'application/json', headers: { accept: 'application/json' } });
    assert.equal(published.status, 200);
    const results = (await new Client(server.url).getJson(`/events/${S}/results.json`)).json<{ document_text: string; document: { ranking: { project: string; rank: number }[] } }>();
    resultsText = results.document_text;
    ranks = new Map(results.document.ranking.map((r) => [r.project, r.rank]));
    assert.equal(ranks.size, RANKED.length);
  });

  describe('every ranked project gets a certificate that verifies and matches the signed results', () => {
    for (const project of RANKED) {
      test(`${project.id} "${project.title}"`, async () => {
        const reply = await new Client(server.url).getJson(`/events/${S}/certificates/${project.id}/signed.json`);
        assert.equal(reply.status, 200);
        const record = reply.json<SignedRecord>();
        assert.equal(verifyText(record.document_text, record.signature, record.public_key), true);
        const c = JSON.parse(record.document_text) as Certificate;
        assert.equal(c.format, 'forgeboard-certificate/v1');
        assert.equal(c.project.title, project.title);
        assert.equal(c.result.rank, ranks.get(project.id));
        assert.equal(c.result.of, RANKED.length);
        assert.equal(c.results.document_sha256, sha256(resultsText), 'tied to the published results document');
        const again = (await new Client(server.url).getJson(`/events/${S}/certificates/${project.id}/signed.json`)).json<SignedRecord>();
        assert.equal(again.signature, record.signature, 'deterministic: same snapshot, same signature');
      });
    }
  });

  test('the superseded duplicate has no certificate', async () => {
    assert.equal((await new Client(server.url).getJson(`/events/${S}/certificates/${DUPLICATE}/signed.json`)).status, 404);
  });

  test('the certificate page shows the place and a valid signature', async () => {
    const page = await new Client(server.url).get(`/events/${S}/certificates/prj_01`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Signature valid/);
    assert.match(page.text, /Placed <strong>\d+(st|nd|rd|th)<\/strong> of 40/);
  });

  describe('every judge gets a signed record, and every review they submitted was counted at their value', () => {
    for (const judge of fixture.judges) {
      test(judge.id, async () => {
        const reply = await as(judge.id).getJson(`/judge/${S}/record.json`);
        assert.equal(reply.status, 200);
        const record = reply.json<SignedRecord>();
        assert.equal(verifyText(record.document_text, record.signature, record.public_key), true);
        const r = JSON.parse(record.document_text) as JudgeRecord;
        assert.equal(r.judge.id, judge.id);
        const filed = fixture.scores.filter((s) => s.judge === judge.id);
        assert.equal(r.reviews.length, filed.length);
        for (const s of filed) assert.deepEqual(r.reviews.find((v) => v.project === s.project)?.criteria, s.criteria);
        assert.ok(r.results);
        assert.equal(r.results.all_counted, true);
        assert.equal(r.results.document_sha256, sha256(resultsText));
        const ranked = filed.filter((s) => s.project !== DUPLICATE);
        assert.equal(r.results.counted.length, ranked.length);
        for (const c of r.results.counted) {
          const mine = r.reviews.find((v) => v.project === c.project);
          assert.ok(mine && mine.weighted !== null && Math.abs(mine.weighted - c.score) < 1e-9, c.project);
        }
        assert.deepEqual(r.results.not_counted.map((n) => n.project), filed.filter((s) => s.project === DUPLICATE).map((s) => s.project));
      });
    }
  });

  describe('who may read a judge record: the same people who may read the scores', () => {
    const cases: [string, () => Client, string, number][] = [
      ['a visitor, own-record route', () => new Client(server.url), `/judge/${S}/record.json`, 401],
      ['a participant, own-record route', () => Client.as(server.url, 'participant'), `/judge/${S}/record.json`, 403],
      ['the organizer, own-record route (organizers do not judge)', () => organizer, `/judge/${S}/record.json`, 403],
      ["judge B, judge A's record", () => Client.as(server.url, 'judge_b'), `/organize/${S}/judges/jdg_24/record.json`, 403],
      ["a participant, judge A's record", () => Client.as(server.url, 'participant'), `/organize/${S}/judges/jdg_24/record.json`, 403],
      ["a visitor, judge A's record", () => new Client(server.url), `/organize/${S}/judges/jdg_24/record.json`, 401],
      ["the organizer, judge A's record", () => organizer, `/organize/${S}/judges/jdg_24/record.json`, 200],
      ["an administrator, judge A's record (audited)", () => new Client(server.url, createSession(server.booted.store, 'usr_demo_admin', new Date())), `/organize/${S}/judges/jdg_24/record.json`, 200],
    ];
    for (const [name, client, url, status] of cases) {
      test(`${name} → ${status}`, async () => {
        const reply = await client().getJson(url);
        assert.equal(reply.status, status);
        if (status !== 200) assert.doesNotMatch(reply.text, /"criteria"/);
      });
    }
  });

  describe('tampering is caught', () => {
    let good: SignedRecord;
    before(async () => {
      good = (await new Client(server.url).getJson(`/events/${S}/certificates/prj_01/signed.json`)).json<SignedRecord>();
    });
    const verify = async (record: Partial<SignedRecord>) => (await new Client(server.url).postJson('/api/verify', record)).json<{ valid: boolean; signed_by_this_instance: boolean; format: string | null }>();

    test('POST /api/verify accepts the certificate as issued', async () => {
      assert.deepEqual({ ...(await verify(good)), problems: undefined }, { valid: true, signed_by_this_instance: true, format: 'forgeboard-certificate/v1', problems: undefined });
    });

    test('a promoted rank breaks the signature', async () => {
      const text = good.document_text.replace(/"rank":\d+/, '"rank":99');
      assert.notEqual(text, good.document_text);
      assert.equal((await verify({ ...good, document_text: text })).valid, false);
    });

    test("a forger's own key is not this instance's", async () => {
      const other = new Store(':memory:');
      migrate(other);
      const key = signingKey(other);
      const text = good.document_text.replace(/"rank":\d+/, '"rank":1');
      const check = await verify({ document_text: text, signature: signText(key, text), public_key: key.publicKey });
      assert.equal(check.valid, true);
      assert.equal(check.signed_by_this_instance, false);
    });

    test('the offline CLI passes the record as issued and fails an edited one', () => {
      const file = path.join(tmp, 'certificate.json');
      fs.writeFileSync(file, JSON.stringify(good));
      const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'verify-record', file], { encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /PASS {2}signature/);
      fs.writeFileSync(file, JSON.stringify({ ...good, document_text: good.document_text.replace(/"rank":\d+/, '"rank":99') }));
      const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'verify-record', file], { encoding: 'utf8' });
      assert.equal(bad.status, 1);
      assert.match(bad.stdout, /FAIL {2}signature/);
    });
  });
});
