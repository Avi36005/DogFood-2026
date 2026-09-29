/**
 * The webhook outbox. audit.ts calls this inside the same transaction that appends the audit
 * entry, so every delivery corresponds to exactly one committed audit entry: a change that rolls
 * back never fires a webhook, and a crash between the change and the send loses nothing (the
 * worker in webhooks.ts picks the row up later). Payloads carry the audit entry's id and hash so
 * a receiver can tie each call to the tamper-evident trail, and never carry the entry's detail
 * (a review's detail holds its scores).
 */
import type { Store } from '../db/store.ts';
import { iso } from '../util/time.ts';
import { newId } from '../util/tokens.ts';

/** What an organizer can subscribe to: the audit actions worth telling another system about. */
export const WEBHOOK_EVENTS = [
  'project.submitted',
  'project.withdrawn',
  'event.submissions_closed',
  'review.submitted',
  'results.published',
  'results.withdrawn',
  'vote.published',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'webhook.ping';

export interface AuditFact {
  id: number;
  hash: string;
  at: string;
  eventId: string;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  summary: string;
}

export function webhookPayload(store: Store, deliveryId: string, type: WebhookEvent, fact: AuditFact | null, eventId: string, at: string): string {
  const event = store.get<{ id: string; slug: string; name: string }>('SELECT id, slug, name FROM events WHERE id = ?', [eventId]);
  return JSON.stringify({
    id: deliveryId,
    type,
    occurred_at: fact?.at ?? at,
    event,
    subject: fact ? { type: fact.subjectType, id: fact.subjectId } : null,
    summary: fact?.summary ?? 'A test delivery from Forgeboard.',
    audit: fact ? { id: fact.id, hash: fact.hash } : null,
  });
}

export function enqueueFromAudit(store: Store, fact: AuditFact, now: Date): void {
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(fact.action)) return;
  const hooks = store.all<{ id: string; events: string }>('SELECT id, events FROM webhooks WHERE event_id = ? AND removed_at IS NULL', [fact.eventId]);
  for (const hook of hooks) {
    if (!(JSON.parse(hook.events) as string[]).includes(fact.action)) continue;
    const id = newId('whd');
    store.run(
      'INSERT INTO webhook_deliveries (id, webhook_id, type, audit_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, hook.id, fact.action, fact.id, webhookPayload(store, id, fact.action as WebhookEvent, fact, fact.eventId, iso(now)), iso(now), iso(now)],
    );
  }
}
