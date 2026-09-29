/**
 * Webhooks (T4): an organizer registers a URL and picks events; each matching audit entry queues
 * a delivery (outbox.ts) and a worker in the server posts it.
 *
 * Every request is signed like Stripe's: header `Forgeboard-Signature: t=<unix seconds>,v1=<hex>`,
 * where v1 is HMAC-SHA256 with the webhook's secret over `<t>.<raw body>`. A receiver recomputes
 * it and rejects stale timestamps, so a captured request cannot be replayed later. Failed
 * deliveries retry with exponential backoff (30 s, 1, 2, 4, 8 min) and are marked failed after
 * six attempts; the organizer sees every attempt and can send a test ping.
 */
import { createHmac } from 'node:crypto';
import type { Store } from '../db/store.ts';
import { notFound, ValidationError } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { iso } from '../util/time.ts';
import { newId, newToken } from '../util/tokens.ts';
import { requireOrganizer } from './access.ts';
import { actorLabel, record } from './audit.ts';
import { WEBHOOK_EVENTS, webhookPayload, type WebhookEvent } from './outbox.ts';
import type { Actor, EventRow } from './types.ts';

export const MAX_ATTEMPTS = 6;
export const BACKOFF_SECONDS = 30;
export const TIMEOUT_MS = 5_000;

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  events: string[];
  created_at: string;
  delivered: number;
  pending: number;
  failed: number;
}

export interface Delivery {
  id: string;
  webhook_id: string;
  type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export function listWebhooks(store: Store, actor: Actor, event: EventRow): Webhook[] {
  requireOrganizer(store, actor, event, 'see the webhooks');
  return store
    .all<Omit<Webhook, 'events'> & { events: string }>(
      `SELECT w.id, w.url, w.secret, w.events, w.created_at,
         (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'delivered') AS delivered,
         (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
         (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed') AS failed
       FROM webhooks w WHERE w.event_id = ? AND w.removed_at IS NULL ORDER BY w.created_at`,
      [event.id],
    )
    .map((w) => ({ ...w, events: JSON.parse(w.events) as string[] }));
}

export function listDeliveries(store: Store, actor: Actor, event: EventRow, limit = 50): Delivery[] {
  requireOrganizer(store, actor, event, 'see webhook deliveries');
  return store.all<Delivery>(
    `SELECT d.id, d.webhook_id, d.type, d.status, d.attempts, d.next_attempt_at, d.last_status, d.last_error, d.created_at, d.delivered_at
     FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE w.event_id = ? ORDER BY d.created_at DESC, d.id LIMIT ?`,
    [event.id, limit],
  );
}

export function createWebhook(store: Store, actor: Actor, event: EventRow, body: Body): Webhook {
  requireOrganizer(store, actor, event, 'add a webhook');
  const form = new FormReader(body);
  const url = form.text('url', { label: 'URL', required: true, max: 500 });
  const raw = body.events;
  const events = (Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : []).map(String);
  form.assertValid();
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // reported below
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new ValidationError({ url: 'Use an http:// or https:// address.' });
  if (!events.length) throw new ValidationError({ events: 'Pick at least one event.' });
  const unknown = events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (unknown.length) throw new ValidationError({ events: `Unknown event: ${unknown.join(', ')}.` });
  return store.tx(() => {
    const id = newId('whk');
    const secret = `whsec_${newToken()}`;
    store.run('INSERT INTO webhooks (id, event_id, url, secret, events, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, event.id, parsed.href, secret, JSON.stringify(events), actor.user?.id ?? null, iso(actor.now)]);
    record(store, actor, { eventId: event.id, action: 'webhook.created', subjectType: 'webhook', subjectId: id, summary: `${actorLabel(actor)} added a webhook to ${parsed.origin} for ${events.join(', ')}.` });
    return { id, url: parsed.href, secret, events, created_at: iso(actor.now), delivered: 0, pending: 0, failed: 0 };
  });
}

function hookOf(store: Store, event: EventRow, webhookId: string): { id: string; url: string } {
  const hook = store.get<{ id: string; url: string }>('SELECT id, url FROM webhooks WHERE id = ? AND event_id = ? AND removed_at IS NULL', [webhookId, event.id]);
  if (!hook) throw notFound('No such webhook.');
  return hook;
}

export function removeWebhook(store: Store, actor: Actor, event: EventRow, webhookId: string): void {
  requireOrganizer(store, actor, event, 'remove a webhook');
  store.tx(() => {
    const hook = hookOf(store, event, webhookId);
    store.run('UPDATE webhooks SET removed_at = ? WHERE id = ?', [iso(actor.now), hook.id]);
    // Nothing more is sent to a removed webhook; its history stays for the record.
    store.run("UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook removed' WHERE webhook_id = ? AND status = 'pending'", [hook.id]);
    record(store, actor, { eventId: event.id, action: 'webhook.removed', subjectType: 'webhook', subjectId: hook.id, summary: `${actorLabel(actor)} removed the webhook to ${new URL(hook.url).origin}.` });
  });
}

/** Queues a test delivery to one webhook, whatever it subscribes to. */
export function pingWebhook(store: Store, actor: Actor, event: EventRow, webhookId: string): string {
  requireOrganizer(store, actor, event, 'ping a webhook');
  return store.tx(() => {
    const hook = hookOf(store, event, webhookId);
    const id = newId('whd');
    const now = iso(actor.now);
    store.run('INSERT INTO webhook_deliveries (id, webhook_id, type, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, hook.id, 'webhook.ping', webhookPayload(store, id, 'webhook.ping' as WebhookEvent, null, event.id, now), now, now]);
    return id;
  });
}

/** The signature header value for a body at a given time. */
export function signatureHeader(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex')}`;
}

/** What a receiver should do: recompute, compare, and refuse old timestamps. */
export function verifySignatureHeader(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds || !parts.v1) return false;
  return signatureHeader(secret, body, t) === `t=${t},v1=${parts.v1}`;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number }>;

/**
 * Sends every delivery that is due, one at a time. Returns how many were attempted. The server
 * calls this every few seconds; tests call it directly.
 */
export async function deliverDue(store: Store, now: Date, send: Fetch = fetch as unknown as Fetch, limit = 20): Promise<number> {
  const due = store.all<{ id: string; type: string; payload: string; attempts: number; url: string; secret: string }>(
    `SELECT d.id, d.type, d.payload, d.attempts, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.removed_at IS NULL ORDER BY d.next_attempt_at, d.id LIMIT ?`,
    [iso(now), limit],
  );
  for (const delivery of due) {
    const attempts = delivery.attempts + 1;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await send(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Forgeboard-Webhooks/1',
          'Forgeboard-Event': delivery.type,
          'Forgeboard-Delivery': delivery.id,
          'Forgeboard-Signature': signatureHeader(delivery.secret, delivery.payload, Math.floor(now.getTime() / 1000)),
        },
        body: delivery.payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
      status = response.status;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 200) : 'request failed';
    }
    if (!error) {
      store.run("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?", [attempts, status, iso(now), delivery.id]);
    } else if (attempts >= MAX_ATTEMPTS) {
      store.run("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status = ?, last_error = ? WHERE id = ?", [attempts, status, error, delivery.id]);
    } else {
      const next = new Date(now.getTime() + BACKOFF_SECONDS * 1000 * 2 ** (attempts - 1));
      store.run('UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?', [attempts, status, error, iso(next), delivery.id]);
    }
  }
  return due.length;
}

/** The background sender: every few seconds, never two runs at once. */
export function startWebhookWorker(store: Store, intervalMs = 2_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    deliverDue(store, new Date())
      .catch((error: unknown) => console.error('webhooks:', error))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
