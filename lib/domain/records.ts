import {
  generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign,
  verify as cryptoVerify, createHash,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { all, get, run, nowIso, DB_PATH } from "../db/client.ts";
import { newId } from "../ids.ts";
import { requireOrganizer, type Capability } from "../authz.ts";
import * as audit from "./audit.ts";
import { byId as eventById } from "./events.ts";

export const PAYLOAD_VERSION = "forgeboard.record/1";
const KEY_DIR = path.join(path.dirname(DB_PATH), "keys");

/**
 * Ed25519 via the Node standard library. No custom cryptography, no external
 * service, no blockchain. The private key lives on the instance's data volume
 * with 0600 permissions and is never committed, exported or logged.
 */
function keyPaths() {
  return { priv: path.join(KEY_DIR, "signing.ed25519.pem"), pub: path.join(KEY_DIR, "signing.pub.pem") };
}

export function ensureKeypair(): { keyId: string; publicPem: string } {
  const { priv, pub } = keyPaths();
  if (!existsSync(priv)) {
    mkdirSync(KEY_DIR, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }) as string, { mode: 0o644 });
    try { chmodSync(priv, 0o600); } catch { /* best effort on exotic filesystems */ }
  }
  const publicPem = readFileSync(pub, "utf8");
  return { keyId: keyIdFor(publicPem), publicPem };
}

/** Short, stable identifier for a public key, so rotation is traceable. */
export function keyIdFor(publicPem: string): string {
  return createHash("sha256").update(publicPem.trim()).digest("hex").slice(0, 16);
}

export function publicKeyPem(): string {
  return ensureKeypair().publicPem;
}

/**
 * Canonical JSON: keys sorted, no incidental whitespace. Both signing and
 * verification serialise through this, so a re-ordered payload still verifies
 * and a changed one never does.
 */
export function canonical(payload: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, walk((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(payload));
}

export function signPayload(payload: unknown): string {
  ensureKeypair();
  const key = createPrivateKey(readFileSync(keyPaths().priv, "utf8"));
  return cryptoSign(null, Buffer.from(canonical(payload), "utf8"), key).toString("base64url");
}

export type VerifyResult =
  | { valid: true; keyId: string; payload: Record<string, unknown> }
  | { valid: false; reason: string };

/** Verification uses only locally published public material; no account needed. */
export function verifyArtifact(artifactJson: string, publicPem = publicKeyPem()): VerifyResult {
  let parsed: { payload?: unknown; signature?: unknown; key_id?: unknown };
  try { parsed = JSON.parse(artifactJson); }
  catch { return { valid: false, reason: "That is not valid JSON." }; }

  if (!parsed || typeof parsed !== "object") return { valid: false, reason: "The artifact is not an object." };
  if (!parsed.payload || typeof parsed.payload !== "object") return { valid: false, reason: "The artifact has no payload." };
  if (typeof parsed.signature !== "string") return { valid: false, reason: "The artifact has no signature." };

  const expectedKeyId = keyIdFor(publicPem);
  if (typeof parsed.key_id === "string" && parsed.key_id !== expectedKeyId) {
    return { valid: false, reason: `Signed with key ${parsed.key_id}, but this instance publishes key ${expectedKeyId}. It may be from another instance, or from before a key rotation.` };
  }
  let ok = false;
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(canonical(parsed.payload), "utf8"),
      createPublicKey(publicPem),
      Buffer.from(parsed.signature, "base64url"),
    );
  } catch { return { valid: false, reason: "The signature is malformed." }; }

  return ok
    ? { valid: true, keyId: expectedKeyId, payload: parsed.payload as Record<string, unknown> }
    : { valid: false, reason: "The signature does not match this payload. It has been altered, or signed by a different key." };
}

// ------------------------------------------------------------- records -----

export type RecordKind = "judge_participation" | "team_participation" | "placement";

export type Artifact = {
  payload: Record<string, unknown>;
  signature: string;
  key_id: string;
  verify_with: string;
};

/**
 * Builds a record from facts already stored. Nothing is issued for work that
 * did not happen: a judge with zero submitted reviews gets a refusal, not a
 * certificate.
 */
export function issueJudgeRecord(cap: Capability, judgeUserId: string): Artifact {
  requireOrganizer(cap);
  const event = eventById(cap.eventId)!;
  const judge = get<{ id: string; display_name: string; email: string }>(
    `SELECT id, display_name, email FROM users WHERE id = ?`, judgeUserId);
  if (!judge) throw new Error("No such account.");

  const facts = get<{ assigned: number; submitted: number; first: string | null; last: string | null }>(
    `SELECT COUNT(a.id) AS assigned,
            SUM(CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
            MIN(r.submitted_at) AS first, MAX(r.submitted_at) AS last
       FROM assignments a LEFT JOIN reviews r ON r.assignment_id = a.id
      WHERE a.event_id = ? AND a.judge_user_id = ? AND a.status != 'revoked'`,
    cap.eventId, judgeUserId)!;

  if ((facts.submitted ?? 0) === 0) {
    throw new Error(`${judge.display_name} has not submitted any reviews for this event, so there is nothing to certify.`);
  }

  const recordId = newId("rec");
  const { keyId } = ensureKeypair();
  const payload = {
    payload_version: PAYLOAD_VERSION,
    record_id: recordId,
    record_type: "judge_participation" as RecordKind,
    event: { id: event.id, name: event.name, slug: event.slug },
    subject: { name: judge.display_name },   // consented public identity only
    facts: {
      reviews_assigned: facts.assigned,
      reviews_submitted: facts.submitted,
      first_review_at: facts.first,
      last_review_at: facts.last,
    },
    issued_at: nowIso(),
    issuer: { instance: "Forgeboard", key_id: keyId },
  };

  const signature = signPayload(payload);
  run(
    `INSERT INTO issued_records (id, event_id, kind, subject_user_id, payload_json, signature, key_id, issued_by, created_at)
     VALUES (?,?, 'judge_participation', ?,?,?,?,?,?)`,
    recordId, cap.eventId, judgeUserId, JSON.stringify(payload), signature, keyId, cap.actor!.id, nowIso(),
  );
  audit.record({
    actor: cap.actor, eventId: cap.eventId, action: "record.issue",
    subjectType: "user", subjectId: judgeUserId, detail: { recordId, kind: "judge_participation" },
  });

  return { payload, signature, key_id: keyId, verify_with: "/verify" };
}

export function issuedFor(cap: Capability) {
  requireOrganizer(cap);
  return all<{ id: string; kind: string; subject_user_id: string; created_at: string; display_name: string; key_id: string }>(
    `SELECT ir.id, ir.kind, ir.subject_user_id, ir.created_at, ir.key_id, u.display_name
       FROM issued_records ir JOIN users u ON u.id = ir.subject_user_id
      WHERE ir.event_id = ? ORDER BY ir.created_at DESC`,
    cap.eventId,
  );
}

export function artifactById(recordId: string): Artifact | null {
  const row = get<{ payload_json: string; signature: string; key_id: string }>(
    `SELECT payload_json, signature, key_id FROM issued_records WHERE id = ?`, recordId);
  if (!row) return null;
  return {
    payload: JSON.parse(row.payload_json),
    signature: row.signature,
    key_id: row.key_id,
    verify_with: "/verify",
  };
}
