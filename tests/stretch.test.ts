/** T4 behaviour: signed records, portability, webhook safety. Internal ids. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(path.join(tmpdir(), "forgeboard-t4-"));
process.env.FORGEBOARD_DB_PATH = path.join(dir, "test.db");
process.env.FORGEBOARD_UPLOAD_DIR = path.join(dir, "uploads");
execFileSync(process.execPath, ["scripts/seed.ts"], { env: process.env, stdio: "pipe", cwd: process.cwd() });

const { get, all } = await import("../lib/db/client.ts");
const { capabilityFor, AccessDenied } = await import("../lib/authz.ts");
const accounts = await import("../lib/domain/accounts.ts");
const records = await import("../lib/domain/records.ts");
const portability = await import("../lib/domain/portability.ts");
const webhooks = await import("../lib/domain/webhooks.ts");
const keys = await import("../lib/api/keys.ts");

const eventId = get<{ id: string }>(`SELECT id FROM events WHERE slug = 'autumn-build-2026'`)!.id;
const organizer = accounts.toActor(accounts.byEmail("organizer@forgeboard.local")!);
const participant = accounts.toActor(accounts.byEmail("participant@forgeboard.local")!);
const orgCap = capabilityFor(organizer, eventId);
const partCap = capabilityFor(participant, eventId);

describe("RECORD: signed judge participation", () => {
  const judgeWithWork = get<{ user_id: string }>(
    `SELECT a.judge_user_id AS user_id FROM assignments a
       JOIN reviews r ON r.assignment_id = a.id
      WHERE a.event_id = ? AND r.status = 'submitted' LIMIT 1`, eventId)!;

  test("a record is issued from stored facts and verifies", () => {
    const artifact = records.issueJudgeRecord(orgCap, judgeWithWork.user_id);
    assert.ok(artifact.signature.length > 40);
    const result = records.verifyArtifact(JSON.stringify(artifact));
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.payload.payload_version, records.PAYLOAD_VERSION);
      assert.ok((result.payload.facts as { reviews_submitted: number }).reviews_submitted > 0);
      // No ballot content and no email address in a public record.
      const text = JSON.stringify(result.payload);
      assert.equal(/raw_weighted|criterion|@/.test(text), false, "record must not leak ballots or emails");
    }
  });

  test("an altered payload is rejected", () => {
    const artifact = records.issueJudgeRecord(orgCap, judgeWithWork.user_id);
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.payload.facts.reviews_submitted = 999;
    const result = records.verifyArtifact(JSON.stringify(tampered));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /does not match|altered/i);
  });

  test("a signature from a different key is rejected", () => {
    const artifact = records.issueJudgeRecord(orgCap, judgeWithWork.user_id);
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
    const stripped = { ...JSON.parse(JSON.stringify(artifact)) };
    delete stripped.key_id;   // isolate the signature check from the key-id check
    const result = records.verifyArtifact(JSON.stringify(stripped), other);
    assert.equal(result.valid, false);
  });

  test("key-id mismatch is reported clearly rather than as a bad signature", () => {
    const artifact = records.issueJudgeRecord(orgCap, judgeWithWork.user_id);
    const wrong = { ...JSON.parse(JSON.stringify(artifact)), key_id: "0000000000000000" };
    const result = records.verifyArtifact(JSON.stringify(wrong));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /key/i);
  });

  test("malformed input is handled without throwing", () => {
    for (const bad of ["", "{", "null", "[]", '{"payload":{}}', '{"signature":"x"}']) {
      const r = records.verifyArtifact(bad);
      assert.equal(r.valid, false);
      if (!r.valid) assert.ok(r.reason.length > 0);
    }
  });

  test("canonical serialization ignores key order", () => {
    assert.equal(records.canonical({ b: 1, a: { d: 2, c: 3 } }), records.canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });

  test("verification survives a fresh read of the key from disk", () => {
    const artifact = records.issueJudgeRecord(orgCap, judgeWithWork.user_id);
    // publicKeyPem() re-reads the PEM each call, which is what a restart does.
    assert.equal(records.verifyArtifact(JSON.stringify(artifact), records.publicKeyPem()).valid, true);
  });

  test("the private key is written with restrictive permissions", () => {
    records.ensureKeypair();
    const keyPath = path.join(dir, "keys", "signing.ed25519.pem");
    assert.ok(existsSync(keyPath));
    assert.equal(statSync(keyPath).mode & 0o077, 0, "private key must not be group or world readable");
  });

  test("no record is issued for a judge who did nothing", () => {
    const idle = accounts.register({ email: `idle-${Date.now()}@forgeboard.local`, password: "test123456", displayName: "Idle" });
    assert.throws(() => records.issueJudgeRecord(orgCap, idle.id), /not submitted any reviews/i);
  });

  test("a participant cannot issue records", () => {
    assert.throws(() => records.issueJudgeRecord(partCap, judgeWithWork.user_id), AccessDenied);
  });
});

describe("PORTABILITY: export and import", () => {
  test("the bundle carries a schema version and no secrets", () => {
    const bundle = portability.exportBundle(orgCap);
    assert.equal(bundle.version, portability.BUNDLE_VERSION);
    const text = JSON.stringify(bundle);
    for (const secret of ["password_hash", "password_salt", "token_hash", "session_hash"]) {
      assert.equal(text.includes(secret), false, `bundle must not contain ${secret}`);
    }
    assert.ok(bundle.projects.length > 0);
    assert.ok(bundle.reviews.length > 0);
  });

  test("a participant cannot export the bundle", () => {
    assert.throws(() => portability.exportBundle(partCap), AccessDenied);
  });

  test("a dry run validates and writes nothing", () => {
    const bundle = portability.exportBundle(orgCap);
    const before = all(`SELECT id FROM events`).length;
    const report = portability.importBundle(organizer, bundle, { dryRun: true });
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(all(`SELECT id FROM events`).length, before);
  });

  test("a malformed bundle is refused with reasons and changes nothing", () => {
    const before = all(`SELECT id FROM events`).length;
    const bad = portability.importBundle(organizer, { version: "nope" }, { dryRun: false });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.length > 0);
    assert.equal(all(`SELECT id FROM events`).length, before);
  });

  test("a broken reference is caught before any write", () => {
    const bundle = portability.exportBundle(orgCap);
    (bundle.projects[0] as Record<string, unknown>).team_id = "tem_does_not_exist";
    const before = all(`SELECT id FROM projects`).length;
    const report = portability.importBundle(organizer, bundle, { dryRun: false });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => /not in the file/.test(p.message)));
    assert.equal(all(`SELECT id FROM projects`).length, before);
  });

  test("an out-of-range or non-numeric imported score is refused before any write", () => {
    for (const bad of [-40, 99, Number.NaN, "4" as unknown as number]) {
      const bundle = JSON.parse(JSON.stringify(portability.exportBundle(orgCap))) as ReturnType<typeof portability.exportBundle>;
      const rv = bundle.reviews.find((r) => r.status === "submitted" && r.scores.length)!;
      rv.scores[0].score = bad;
      const before = all(`SELECT id FROM events`).length;
      const report = portability.importBundle(organizer, bundle, { dryRun: false });
      assert.equal(report.ok, false, `score ${String(bad)} should be refused`);
      assert.ok(report.problems.some((p) => /outside/.test(p.message)));
      assert.equal(all(`SELECT id FROM events`).length, before);
    }
  });

  test("a criterion with an unusable weight or scale is refused", () => {
    const bundle = portability.exportBundle(orgCap);
    (bundle.rubrics[0].criteria[0] as Record<string, unknown>).scale_max =
      (bundle.rubrics[0].criteria[0] as Record<string, unknown>).scale_min;
    const report = portability.importBundle(organizer, bundle, { dryRun: true });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => /Scale maximum/.test(p.message)));
  });

  test("weighted scores are recomputed from criterion scores, not trusted from the file", async () => {
    const bundle = portability.exportBundle(orgCap);
    const rv = bundle.reviews.find((r) => r.status === "submitted" && r.scores.length)!;
    const honest = rv.raw_weighted;
    rv.raw_weighted = 999;
    rv.raw_weighted_100 = 25000;
    const report = portability.importBundle(organizer, bundle, { dryRun: false });
    assert.equal(report.ok, true);
    const events = await import("../lib/domain/events.ts");
    const copy = events.bySlug(report.eventSlug!)!;
    const max = get<{ w: number; w100: number }>(
      `SELECT MAX(r.raw_weighted) AS w, MAX(r.raw_weighted_100) AS w100
         FROM reviews r JOIN assignments a ON a.id = r.assignment_id WHERE a.event_id = ?`, copy.id)!;
    assert.ok(max.w <= 5 && max.w100 <= 100, `stored ${max.w} / ${max.w100}`);
    assert.ok(honest !== null && honest <= 5);
  });

  test("a real import reconstructs the event and preserves derived results", async () => {
    const bundle = portability.exportBundle(orgCap);
    const report = portability.importBundle(organizer, bundle, { dryRun: false });
    assert.equal(report.ok, true);
    assert.ok(report.eventSlug);

    const events = await import("../lib/domain/events.ts");
    const results = await import("../lib/domain/results.ts");
    const copy = events.bySlug(report.eventSlug!)!;
    const copyCap = capabilityFor(organizer, copy.id);

    assert.equal(copy.status, "draft", "an imported event should not arrive live");
    assert.equal(
      all(`SELECT id FROM projects WHERE event_id = ?`, copy.id).length,
      all(`SELECT id FROM projects WHERE event_id = ?`, eventId).length,
    );

    // The derived ranking must survive the round trip.
    const originalTop = results.normalizationReport(orgCap)!.projects.slice(0, 5).map((p) => p.projectName);
    const copyTop = results.normalizationReport(copyCap)!.projects.slice(0, 5).map((p) => p.projectName);
    assert.deepEqual(copyTop, originalTop);
  });

  test("re-importing the same file creates a separate event rather than duplicating rows", () => {
    const bundle = portability.exportBundle(orgCap);
    const reviewsBefore = all(`SELECT r.id FROM reviews r JOIN assignments a ON a.id = r.assignment_id WHERE a.event_id = ?`, eventId).length;
    const a = portability.importBundle(organizer, bundle, { dryRun: false });
    const b = portability.importBundle(organizer, bundle, { dryRun: false });
    assert.notEqual(a.eventSlug, b.eventSlug);
    const reviewsAfter = all(`SELECT r.id FROM reviews r JOIN assignments a ON a.id = r.assignment_id WHERE a.event_id = ?`, eventId).length;
    assert.equal(reviewsAfter, reviewsBefore, "the source event must be untouched");
  });

  test("imported accounts cannot be signed into", () => {
    const bundle = portability.exportBundle(orgCap);
    bundle.people.push({ email: `ghost-${Date.now()}@elsewhere.test`, display_name: "Ghost" });
    const report = portability.importBundle(organizer, bundle, { dryRun: false });
    assert.equal(report.ok, true);
    const ghost = get<{ password_hash: string; disabled_at: string | null }>(
      `SELECT password_hash, disabled_at FROM users WHERE email_ci LIKE 'ghost-%'`)!;
    assert.equal(ghost.password_hash, "");
    assert.ok(ghost.disabled_at, "an imported account must arrive disabled");
  });
});

describe("WEBHOOK: callback safety", () => {
  test("private, loopback and metadata addresses are refused", async () => {
    for (const url of [
      "http://127.0.0.1/hook", "http://localhost/hook", "http://10.0.0.5/hook",
      "http://192.168.1.10/hook", "http://169.254.169.254/latest/meta-data",
      "http://172.16.4.4/hook", "http://[::1]/hook",
    ]) {
      await assert.rejects(webhooks.assertSafeUrl(url), /private or reserved|resolve/i, `${url} should be refused`);
    }
  });

  test("non-http schemes and embedded credentials are refused", async () => {
    await assert.rejects(webhooks.assertSafeUrl("file:///etc/passwd"), /http/i);
    await assert.rejects(webhooks.assertSafeUrl("ftp://example.com/x"), /http/i);
    await assert.rejects(webhooks.assertSafeUrl("http://user:pass@example.com/x"), /credentials/i);
    await assert.rejects(webhooks.assertSafeUrl("not a url"), /valid URL/i);
  });

  test("signatures verify and reject tampering", () => {
    const secret = "s3cret";
    const body = JSON.stringify({ hello: "world" });
    const sig = webhooks.sign(secret, "dlv_1", "2026-09-21T00:00:00Z", body);
    assert.equal(webhooks.verifySignature(secret, "dlv_1", "2026-09-21T00:00:00Z", body, sig), true);
    assert.equal(webhooks.verifySignature(secret, "dlv_1", "2026-09-21T00:00:00Z", body + " ", sig), false);
    assert.equal(webhooks.verifySignature("wrong", "dlv_1", "2026-09-21T00:00:00Z", body, sig), false);
    assert.equal(webhooks.verifySignature(secret, "dlv_2", "2026-09-21T00:00:00Z", body, sig), false);
  });

  test("registering a webhook requires the organizer role", async () => {
    await assert.rejects(webhooks.register(partCap, "https://example.com/hook", []), (e) => e instanceof AccessDenied);
  });
});

describe("API: keys share the interface's authorization", () => {
  test("a key is stored hashed and resolves to its owner", () => {
    const token = keys.issue(orgCap, "ci", "read");
    assert.match(token, /^fbk_/);
    assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM api_keys WHERE token_hash = ?`, token)!.n, 0,
      "the raw token must not be stored");
    const resolved = keys.resolve(`Bearer ${token}`);
    assert.equal(resolved?.userId, organizer.id);
    assert.deepEqual(resolved?.scopes, ["read"]);
  });

  test("a revoked or unknown key resolves to nothing", () => {
    const token = keys.issue(orgCap, "temp", "read");
    const row = keys.list(orgCap).find((k) => k.label === "temp")!;
    keys.revoke(orgCap, row.id);
    assert.equal(keys.resolve(`Bearer ${token}`), null);
    assert.equal(keys.resolve("Bearer fbk_nonsense"), null);
    assert.equal(keys.resolve(null), null);
  });

  test("a participant cannot mint keys", () => {
    assert.throws(() => keys.issue(partCap, "sneaky", "read,write"), AccessDenied);
  });
});

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
