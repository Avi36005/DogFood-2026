import { createHash } from 'node:crypto';
import type { Store } from '../db/store.ts';
import { iso } from '../util/time.ts';
import type { Actor } from './types.ts';

/** The prev_hash of the first chained entry. */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  eventId?: string | null;
  action: string;
  subjectType?: string | null;
  subjectId?: string | null;
  /** One sentence an organizer can read without knowing the schema. */
  summary: string;
  detail?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: number;
  at: string;
  event_id: string | null;
  actor_id: string | null;
  actor_label: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  summary: string;
  detail: string | null;
  ip: string | null;
  prev_hash: string | null;
  hash: string | null;
}

export function actorLabel(actor: Actor): string {
  return actor.user ? `${actor.user.name} <${actor.user.email}>` : 'system';
}

/**
 * The hash of one entry: SHA-256 over the previous entry's hash and this entry's fields, as a
 * JSON array so no field can bleed into its neighbour. Changing any stored field, reordering
 * entries or removing one changes every hash after it.
 */
export function entryHash(prevHash: string, row: Pick<AuditRow, 'at' | 'event_id' | 'actor_id' | 'actor_label' | 'action' | 'subject_type' | 'subject_id' | 'summary' | 'detail' | 'ip'>): string {
  const fields = [prevHash, row.at, row.event_id, row.actor_id, row.actor_label, row.action, row.subject_type, row.subject_id, row.summary, row.detail, row.ip];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function record(store: Store, actor: Actor, entry: AuditEntry): void {
  const row = {
    at: iso(actor.now),
    event_id: entry.eventId ?? null,
    actor_id: actor.user?.id ?? null,
    actor_label: actorLabel(actor),
    action: entry.action,
    subject_type: entry.subjectType ?? null,
    subject_id: entry.subjectId ?? null,
    summary: entry.summary,
    detail: entry.detail ? JSON.stringify(entry.detail) : null,
    ip: actor.ip,
  };
  // Reading the head and appending happen under the write lock, so two processes (the server
  // and a command-line tool) can never both extend the same entry and fork the chain.
  store.tx(() => {
    const prevHash = store.get<{ hash: string | null }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')?.hash ?? GENESIS_HASH;
    store.run(
      `INSERT INTO audit_log (at, event_id, actor_id, actor_label, action, subject_type, subject_id, summary, detail, ip, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.at, row.event_id, row.actor_id, row.actor_label, row.action, row.subject_type, row.subject_id, row.summary, row.detail, row.ip, prevHash, entryHash(prevHash, row)],
    );
  });
}

export interface ChainHead {
  id: number;
  hash: string;
}

export interface ChainReport {
  ok: boolean;
  entries: number;
  /** Entries written before the chain existed (schema version 1); they carry no hash. */
  unchained: number;
  verified: number;
  head: ChainHead | null;
  /** The first entry that does not verify, and why. */
  broken: { id: number; reason: string } | null;
}

/** The newest entry: quoting it in a signed document anchors everything before it. */
export function chainHead(store: Store): ChainHead | null {
  const row = store.get<{ id: number; hash: string | null }>('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
  return row?.hash ? { id: row.id, hash: row.hash } : null;
}

/** Walks the whole log in id order and recomputes every hash. */
export function verifyChain(store: Store): ChainReport {
  const report: ChainReport = { ok: true, entries: 0, unchained: 0, verified: 0, head: null, broken: null };
  let previous: string | null = null;
  let started = false;
  for (const row of store.db.prepare('SELECT * FROM audit_log ORDER BY id').iterate() as Iterable<AuditRow>) {
    report.entries++;
    const fail = (reason: string) => {
      report.ok = false;
      report.broken ??= { id: row.id, reason };
    };
    if (row.hash === null) {
      if (started) fail('an entry after the chain started has no hash');
      else report.unchained++;
      continue;
    }
    // record() links the first chained entry to GENESIS_HASH and every later one to its predecessor.
    const expectedPrev = previous ?? GENESIS_HASH;
    started = true;
    if (row.prev_hash !== expectedPrev) fail('it does not point at the entry before it (an entry was removed, inserted or reordered)');
    else if (entryHash(expectedPrev, row) !== row.hash) fail('its contents no longer match its hash (the entry was edited)');
    else report.verified++;
    previous = row.hash;
    report.head = { id: row.id, hash: row.hash };
  }
  return report;
}

export interface AuditQuery {
  action?: string;
  /** Show entries older than this id (keyset pagination: stable while new entries arrive). */
  before?: number;
  limit?: number;
}

export function listAudit(store: Store, eventId: string | null, query: AuditQuery = {}): AuditRow[] {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const clauses = [eventId === null ? 'event_id IS NULL' : 'event_id = $event'];
  const params: Record<string, string | number> = { limit };
  if (eventId !== null) params.event = eventId;
  if (query.action) {
    clauses.push('(action = $action OR action LIKE $prefix)');
    params.action = query.action;
    params.prefix = `${query.action}.%`;
  }
  if (query.before) {
    clauses.push('id < $before');
    params.before = query.before;
  }
  return store.all<AuditRow>(
    `SELECT * FROM audit_log WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT $limit`,
    params,
  );
}

export function auditActions(store: Store, eventId: string): string[] {
  return store
    .all<{ action: string }>('SELECT DISTINCT action FROM audit_log WHERE event_id = ? ORDER BY action', [eventId])
    .map((row) => row.action);
}
