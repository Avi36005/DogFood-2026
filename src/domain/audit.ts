import type { Store } from '../db/store.ts';
import { iso } from '../util/time.ts';
import type { Actor } from './types.ts';

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
}

export function actorLabel(actor: Actor): string {
  return actor.user ? `${actor.user.name} <${actor.user.email}>` : 'system';
}

export function record(store: Store, actor: Actor, entry: AuditEntry): void {
  store.run(
    `INSERT INTO audit_log (at, event_id, actor_id, actor_label, action, subject_type, subject_id, summary, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      iso(actor.now),
      entry.eventId ?? null,
      actor.user?.id ?? null,
      actorLabel(actor),
      entry.action,
      entry.subjectType ?? null,
      entry.subjectId ?? null,
      entry.summary,
      entry.detail ? JSON.stringify(entry.detail) : null,
      actor.ip,
    ],
  );
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
