import { createHash, randomBytes } from "node:crypto";
import { all, get, run, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { requireOrganizer, type Capability } from "../authz.ts";
import * as audit from "../domain/audit.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type KeyRow = {
  id: string; event_id: string | null; user_id: string; label: string;
  scopes: string; created_at: string; last_used_at: string | null; revoked_at: string | null;
};

/** Returned once. Only the hash is stored, exactly as with sessions. */
export function issue(cap: Capability, label: string, scopes: "read" | "read,write"): string {
  requireOrganizer(cap);
  const token = `fbk_${randomBytes(24).toString("base64url")}`;
  run(
    `INSERT INTO api_keys (id, event_id, user_id, label, token_hash, scopes, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId("key"), cap.eventId, cap.actor!.id, label.slice(0, 80), sha(token), scopes, nowIso(),
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "apikey.issue", subjectType: "apikey", subjectId: label, detail: { scopes } });
  return token;
}

export function list(cap: Capability): KeyRow[] {
  requireOrganizer(cap);
  return all<KeyRow>(`SELECT id, event_id, user_id, label, scopes, created_at, last_used_at, revoked_at
                        FROM api_keys WHERE event_id = ? ORDER BY created_at DESC`, cap.eventId);
}

export function revoke(cap: Capability, id: string) {
  requireOrganizer(cap);
  run(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND event_id = ?`, nowIso(), id, cap.eventId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "apikey.revoke", subjectType: "apikey", subjectId: id });
}

export type Resolved = { userId: string; eventId: string | null; scopes: string[] };

/** Maps a bearer token to its owner. The key carries no powers of its own. */
export function resolve(header: string | null): Resolved | null {
  if (!header) return null;
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!token) return null;
  const row = get<{ id: string; user_id: string; event_id: string | null; scopes: string }>(
    `SELECT id, user_id, event_id, scopes FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL`, sha(token));
  if (!row) return null;
  run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, nowIso(), row.id);
  return { userId: row.user_id, eventId: row.event_id, scopes: row.scopes.split(",") };
}
