import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseBundle, verifyBundle, type ResultsDocument } from '../../src/domain/evidence.ts';
import { Client, startServer } from '../helpers.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const cli = (args: string[], env: Record<string, string> = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }) };
  } catch (error) {
    const e = error as { status: number; stdout: string };
    return { code: e.status, out: e.stdout };
  }
};

/** Publishing produces evidence anyone can check without trusting the server. */
describe('signed, verifiable results', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let org: Client;
  const S = '/organize/sample-hack-2026';

  before(async () => {
    server = await startServer();
    org = Client.as(server.url, 'organizer');
    assert.equal((await org.postForm(`${S}/results/publish`, {})).status, 303);
  });
  after(() => server.close());

  test('the public results.json is signed, and carries intervals, commitment and audit anchor but no per-review scores', async () => {
    const reply = await new Client(server.url).get('/events/sample-hack-2026/results.json');
    assert.equal(reply.status, 200);
    const body = reply.json<{ document_text: string; signature: string; public_key: string; document: ResultsDocument }>();
    assert.deepEqual(verifyBundle(parseBundle(reply.text)), { signature: true, fingerprint: null, refit: null, problems: [] });
    const doc = body.document;
    assert.equal(doc.format, 'forgeboard-results/v1');
    assert.equal(doc.ranking[0]?.title, 'Iron Switch');
    assert.equal(doc.ranking[0]?.rank_interval?.[0], 1);
    assert.equal(doc.method.commitment?.unchanged, true);
    assert.equal(doc.inputs.reviews, 121);
    assert.ok(doc.audit_anchor && doc.audit_anchor.id > 0);
    assert.equal(doc.certainty?.winner_holds, 22);
    assert.doesNotMatch(reply.text, /"J01"/, 'pseudonymized per-review inputs stay with the organizer');
  });

  test('changing one number in the document breaks the signature', async () => {
    const bundle = parseBundle((await new Client(server.url).get('/events/sample-hack-2026/results.json')).text);
    const doc = JSON.parse(bundle.document_text) as ResultsDocument;
    (doc.ranking[1] as { score: number }).score += 0.5;
    const report = verifyBundle({ ...bundle, document_text: JSON.stringify(doc) });
    assert.equal(report.signature, false);
  });

  test('the capsule: organizers only, and it verifies itself end to end', async () => {
    assert.equal((await Client.as(server.url, 'participant').get(`${S}/results/capsule.html`)).status, 403);
    assert.equal((await Client.as(server.url, 'judge_a').get(`${S}/results/capsule.html`)).status, 403);
    const reply = await org.get(`${S}/results/capsule.html`);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-disposition') ?? '', /attachment; filename="sample-hack-2026-results-res_/);
    assert.doesNotMatch(reply.text, /<script src=|https?:\/\/(?!localhost)[a-z]/i, 'no external resources: it works offline');
    const bundle = parseBundle(reply.text);
    assert.equal(bundle.inputs?.length, 121);
    assert.deepEqual(verifyBundle(bundle), { signature: true, fingerprint: true, refit: true, problems: [] });

    // Swap two reviews' scores: the fingerprint and the refit both notice.
    const inputs = structuredClone(bundle.inputs ?? []);
    const [x, y] = [inputs[0], inputs[5]];
    if (x && y) [x[2], y[2]] = [y[2], x[2]];
    const tampered = verifyBundle({ ...bundle, inputs });
    assert.equal(tampered.signature, true);
    assert.equal(tampered.fingerprint, false);
  });

  test('pages: the public results say the signature is valid; the audit trail says the chain verifies', async () => {
    const pageText = (await new Client(server.url).get('/events/sample-hack-2026/results')).text;
    assert.match(pageText, /signature valid/);
    assert.match(pageText, /method unchanged/);
    assert.match(pageText, /Likely place \(90%\)/);
    const results = (await org.get(`${S}/results`)).text;
    assert.match(results, /How sure is this ranking\?/);
    assert.match(results, /statistical tie/);
    assert.match((await org.get(`${S}/audit`)).text, /Tamper-evident/);
  });

  test('command line: verify-results on the capsule and the JSON, verify-audit on the database', async () => {
    const capsule = path.join(server.dir, 'capsule.html');
    fs.writeFileSync(capsule, (await org.get(`${S}/results/capsule.html`)).text);
    const json = path.join(server.dir, 'results.json');
    fs.writeFileSync(json, (await new Client(server.url).get('/events/sample-hack-2026/results.json')).text);

    const full = cli(['verify-results', capsule]);
    assert.equal(full.code, 0, full.out);
    assert.match(full.out, /PASS {2}signature/);
    assert.match(full.out, /PASS {2}refit/);
    const light = cli(['verify-results', json]);
    assert.equal(light.code, 0, light.out);
    assert.match(light.out, /SKIP {2}refit/);

    const audit = cli(['verify-audit'], { FORGEBOARD_DB_PATH: path.join(server.dir, 'test.db') });
    assert.equal(audit.code, 0, audit.out);
    assert.match(audit.out, /^PASS {2}\d+ chained entries verify/);
  });
});
