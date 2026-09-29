import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { migrate } from '../../src/db/migrate.ts';
import { Store } from '../../src/db/store.ts';
import { GENESIS_HASH, record, verifyChain } from '../../src/domain/audit.ts';
import { commitmentStatus, configHash, methodConfig } from '../../src/domain/commitment.ts';
import { inputsFingerprint, pseudonymousInputs, ranksFromScores } from '../../src/domain/evidence.ts';
import { importFixtures } from '../../src/domain/fixtures.ts';
import { signingKey, signText, verifyText } from '../../src/domain/signing.ts';
import { systemActor } from '../../src/domain/types.ts';
import { FIXTURES } from '../helpers.ts';

const dirs: string[] = [];
function freshStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-evidence-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'e.db'));
  migrate(store);
  return store;
}
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const note = (store: Store, summary: string) => record(store, systemActor(), { action: 'test.note', summary });

describe('the audit chain', () => {
  test('every entry links to the one before it, starting from the genesis hash', () => {
    const store = freshStore();
    for (const n of [1, 2, 3]) note(store, `entry ${n}`);
    const rows = store.all<{ prev_hash: string; hash: string }>('SELECT prev_hash, hash FROM audit_log ORDER BY id');
    assert.equal(rows[0]?.prev_hash, GENESIS_HASH);
    assert.equal(rows[1]?.prev_hash, rows[0]?.hash);
    assert.equal(rows[2]?.prev_hash, rows[1]?.hash);
    assert.deepEqual(verifyChain(store), { ok: true, entries: 3, unchained: 0, verified: 3, head: { id: 3, hash: rows[2]?.hash }, broken: null });
  });

  test('SQL cannot edit it, and an edit made around the triggers is caught', () => {
    const store = freshStore();
    for (const n of [1, 2, 3]) note(store, `entry ${n}`);
    assert.throws(() => store.run("UPDATE audit_log SET summary = 'rewritten' WHERE id = 2"), /append-only/);
    // Someone with the database file drops the trigger and rewrites history.
    store.exec('DROP TRIGGER audit_log_no_update');
    store.run("UPDATE audit_log SET summary = 'rewritten' WHERE id = 2");
    const report = verifyChain(store);
    assert.equal(report.ok, false);
    assert.deepEqual(report.broken, { id: 2, reason: 'its contents no longer match its hash (the entry was edited)' });
  });

  test('a removed entry breaks the link of the entry after it', () => {
    const store = freshStore();
    for (const n of [1, 2, 3]) note(store, `entry ${n}`);
    store.exec('DROP TRIGGER audit_log_no_delete');
    store.run('DELETE FROM audit_log WHERE id = 2');
    assert.equal(verifyChain(store).broken?.id, 3);
    assert.match(verifyChain(store).broken?.reason ?? '', /does not point at the entry before it/);
  });

  test('entries written before the chain existed are counted, not trusted', () => {
    const store = freshStore();
    store.run("INSERT INTO audit_log (at, actor_label, action, summary) VALUES ('2026-01-01T00:00:00.000Z', 'system', 'legacy', 'before version 2')");
    note(store, 'chained');
    const report = verifyChain(store);
    assert.equal(report.ok, true);
    assert.equal(report.unchained, 1);
    assert.equal(report.verified, 1);
  });
});

describe('results signatures', () => {
  test('sign and verify; any change to the text or the key fails', () => {
    const store = freshStore();
    const key = signingKey(store);
    const text = '{"rank":1,"score":4.303}';
    const signature = signText(key, text);
    assert.equal(verifyText(text, signature, key.publicKey), true);
    assert.equal(verifyText(text.replace('4.303', '4.304'), signature, key.publicKey), false);
    const other = signingKey(freshStore());
    assert.notEqual(other.publicKey, key.publicKey);
    assert.equal(verifyText(text, signature, other.publicKey), false);
    assert.equal(verifyText(text, 'not-a-signature', key.publicKey), false);
  });

  test('the key is made once and kept, so every snapshot of an instance has the same public key', () => {
    const store = freshStore();
    assert.equal(signingKey(store).publicKey, signingKey(store).publicKey);
    assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM settings WHERE key = 'results_signing_key'")?.n, 1);
  });

  test('inputs are pseudonymized in id order and fingerprinted', () => {
    const inputs = pseudonymousInputs([
      { judge: 'jdg_24', project: 'prj_02', score: 4 },
      { judge: 'jdg_03', project: 'prj_02', score: 3 },
      { judge: 'jdg_03', project: 'prj_01', score: 5 },
    ]);
    assert.deepEqual(inputs, [['J01', 'prj_01', 5], ['J01', 'prj_02', 3], ['J02', 'prj_02', 4]]);
    assert.match(inputsFingerprint(inputs), /^[0-9a-f]{64}$/);
    assert.notEqual(inputsFingerprint(inputs), inputsFingerprint([...inputs].reverse()));
  });

  test('competition ranks from scores: ties share a place', () => {
    assert.deepEqual([...ranksFromScores(new Map([['a', 4], ['b', 3.5], ['c', 3.5], ['d', 2]]))], [['a', 1], ['b', 2], ['c', 2], ['d', 4]]);
  });
});

describe('method commitment', () => {
  test('the fixture import fixes the method with its first scores, and a later weight change is detected', () => {
    const store = freshStore();
    importFixtures(store, systemActor(), JSON.parse(fs.readFileSync(FIXTURES, 'utf8')));
    const committed = store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE event_id = 'evt_01' AND action = 'method.committed'");
    assert.equal(committed.length, 1, 'committed exactly once');
    const status = commitmentStatus(store, 'evt_01');
    assert.equal(status?.unchanged, true);
    assert.equal(status?.committedHash, configHash(methodConfig(store, 'evt_01')));

    store.run("UPDATE criteria SET weight = 3 WHERE event_id = 'evt_01' AND key = 'innovation'");
    const changed = commitmentStatus(store, 'evt_01');
    assert.equal(changed?.unchanged, false);
    assert.equal(changed?.committedHash, status?.committedHash, 'the commitment itself never moves');
  });
});
