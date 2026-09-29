/**
 * Method pre-commitment. When the first score of an event is stored, the scoring method, λ, the
 * scale and the rubric weights are hashed, and the hash goes into the hash-chained audit trail.
 * At publication the configuration in use is hashed again and compared, and the answer is part
 * of the signed results.
 *
 * Organizers may still change weights after scoring starts (raw criterion scores are kept, and
 * every change is audited). What they cannot do is retune the method after seeing who is ahead
 * without the published results saying so.
 */
import { createHash } from 'node:crypto';
import type { Store } from '../db/store.ts';
import { record } from './audit.ts';
import { listCriteria } from './events.ts';
import { DEFAULT_LAMBDA, METHOD } from './normalization.ts';
import type { Actor } from './types.ts';

export interface MethodConfig {
  method: string;
  lambda: number;
  scale: [number, number];
  /** Criterion key → weight, keys sorted. */
  weights: Record<string, number>;
}

export interface CommitmentStatus {
  committedAt: string;
  committedHash: string;
  currentHash: string;
  unchanged: boolean;
  /** Rubric changes recorded after the commitment. */
  laterRubricChanges: number;
}

export function methodConfig(store: Store, eventId: string, lambda = DEFAULT_LAMBDA): MethodConfig {
  const event = store.get<{ score_min: number; score_max: number }>('SELECT score_min, score_max FROM events WHERE id = ?', [eventId]);
  const criteria = listCriteria(store, eventId).map((c) => [c.key, c.weight] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { method: METHOD, lambda, scale: [event?.score_min ?? 0, event?.score_max ?? 0], weights: Object.fromEntries(criteria) };
}

export function configHash(config: MethodConfig): string {
  const canonical = JSON.stringify([config.method, config.lambda, config.scale, Object.entries(config.weights)]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Records the commitment the first time scores exist for the event. Call inside the scoring transaction. */
export function commitMethodIfFirst(store: Store, actor: Actor, eventId: string): void {
  if (store.get("SELECT 1 FROM audit_log WHERE event_id = ? AND action = 'method.committed'", [eventId])) return;
  const config = methodConfig(store, eventId);
  const hash = configHash(config);
  record(store, actor, {
    eventId,
    action: 'method.committed',
    subjectType: 'event',
    subjectId: eventId,
    summary: `Scoring started, so the method was fixed: ${config.method}, λ = ${config.lambda}, scale ${config.scale.join('–')}, weights ${Object.entries(config.weights).map(([k, w]) => `${k} ${w}`).join(', ')}. Fingerprint ${hash.slice(0, 12)}.`,
    detail: { hash, config },
  });
}

export function commitmentStatus(store: Store, eventId: string): CommitmentStatus | null {
  const entry = store.get<{ id: number; at: string; detail: string }>(
    "SELECT id, at, detail FROM audit_log WHERE event_id = ? AND action = 'method.committed' ORDER BY id LIMIT 1",
    [eventId],
  );
  if (!entry) return null;
  const committedHash = (JSON.parse(entry.detail) as { hash: string }).hash;
  const currentHash = configHash(methodConfig(store, eventId));
  const later = store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE event_id = ? AND action = 'rubric.changed' AND id > ?", [eventId, entry.id]);
  return { committedAt: entry.at, committedHash, currentHash, unchanged: committedHash === currentHash, laterRubricChanges: later?.n ?? 0 };
}
