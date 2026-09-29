import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { all, get, run, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { requireOrganizer, type Capability } from "../authz.ts";
import * as audit from "./audit.ts";

export const TOPICS = [
  "project.submitted", "project.withdrawn", "project.eligibility_changed",
  "review.submitted", "assignment.created",
  "results.published", "event.status_changed",
  "vote.cast", "comment.added",
] as const;
export type Topic = (typeof TOPICS)[number];

const MAX_ATTEMPTS = 4;

/**
 * SSRF guard for operator-supplied callback URLs.
 *
 * Blocks non-HTTP schemes, credentials in the URL, and any host that resolves
 * to a loopback, link-local, private or reserved address. Resolution happens
 * here rather than trusting the hostname, so `evil.example` pointing at
 * 169.254.169.254 is refused too.
 *
 * FORGEBOARD_WEBHOOK_ALLOW_LOCAL=1 permits loopback for local testing. It is a
 * narrow, explicit opt-in and never disables the rest of the checks.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("That is not a valid URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Webhook URLs must use http or https.");
  if (url.username || url.password) throw new Error("Credentials in the URL are not accepted.");

  const allowLocal = process.env.FORGEBOARD_WEBHOOK_ALLOW_LOCAL === "1";
  const addresses: string[] = [];
  if (isIP(url.hostname)) addresses.push(url.hostname);
  else {
    try {
      const resolved = await lookup(url.hostname, { all: true });
      addresses.push(...resolved.map((r) => r.address));
    } catch { throw new Error(`Could not resolve ${url.hostname}.`); }
  }
  if (addresses.length === 0) throw new Error(`Could not resolve ${url.hostname}.`);

  for (const addr of addresses) {
    if (isBlocked(addr) && !allowLocal) {
      throw new Error(`${url.hostname} resolves to ${addr}, which is a private or reserved address. Refusing to call it.`);
    }
  }
  return url;
}

function isBlocked(addr: string): boolean {
  if (isIP(addr) === 6) {
    const a = addr.toLowerCase();
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd")
      || a.startsWith("fe80") || a.startsWith("::ffff:");
  }
  const p = addr.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)              // link-local, incl. cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)    // CGNAT
    || a >= 224;                              // multicast and reserved
}

export function sign(secret: string, deliveryId: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${deliveryId}.${timestamp}.${body}`).digest("hex");
}

/** Constant-time comparison, for consumers implementing verification. */
export function verifySignature(secret: string, deliveryId: string, timestamp: string, body: string, provided: string): boolean {
  const expected = Buffer.from(sign(secret, deliveryId, timestamp, body), "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type WebhookRow = {
  id: string; event_id: string; url: string; secret: string; topics: string;
  active: number; created_at: string; last_status: string; failures: number;
};

export async function register(cap: Capability, url: string, topics: string[]): Promise<WebhookRow & { secret: string }> {
  requireOrganizer(cap);
  await assertSafeUrl(url);
  const id = newId("whk");
  const secret = randomBytes(32).toString("base64url");
  run(
    `INSERT INTO webhooks (id, event_id, url, secret, topics, created_by, created_at) VALUES (?,?,?,?,?,?,?)`,
    id, cap.eventId, url, secret, topics.length ? topics.join(",") : "*", cap.actor!.id, nowIso(),
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "webhook.register", subjectType: "webhook", subjectId: id, detail: { url, topics } });
  return get<WebhookRow>(`SELECT * FROM webhooks WHERE id = ?`, id)!;
}

export function list(cap: Capability): WebhookRow[] {
  requireOrganizer(cap);
  return all<WebhookRow>(`SELECT * FROM webhooks WHERE event_id = ? ORDER BY created_at DESC`, cap.eventId);
}

export function remove(cap: Capability, id: string) {
  requireOrganizer(cap);
  run(`DELETE FROM webhooks WHERE id = ? AND event_id = ?`, id, cap.eventId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "webhook.remove", subjectType: "webhook", subjectId: id });
}

export function deliveries(cap: Capability, limit = 50) {
  requireOrganizer(cap);
  return all<{ id: string; delivery_id: string; topic: string; status: string; attempts: number; last_error: string; created_at: string; url: string }>(
    `SELECT d.id, d.delivery_id, d.topic, d.status, d.attempts, d.last_error, d.created_at, w.url
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE w.event_id = ? ORDER BY d.created_at DESC LIMIT ?`,
    cap.eventId, limit,
  );
}

/**
 * Queues a delivery per subscribed webhook and sends it in the background.
 *
 * Delivery is at-least-once: a retry after a timeout can produce a duplicate,
 * so every payload carries a stable `delivery_id` and consumers are expected to
 * deduplicate on it. Nothing here promises exactly-once.
 */
export function emit(eventId: string, topic: Topic, data: Record<string, unknown>): void {
  const hooks = all<WebhookRow>(
    `SELECT * FROM webhooks WHERE event_id = ? AND active = 1`, eventId,
  ).filter((w) => w.topics === "*" || w.topics.split(",").includes(topic));

  for (const hook of hooks) {
    const deliveryId = newId("dlv");
    const payload = { id: deliveryId, topic, event_id: eventId, occurred_at: nowIso(), data };
    run(
      `INSERT INTO webhook_deliveries (id, webhook_id, delivery_id, topic, payload_json, status, created_at)
       VALUES (?,?,?,?,?, 'pending', ?)`,
      newId("wdl"), hook.id, deliveryId, topic, JSON.stringify(payload), nowIso(),
    );
    // Fire and forget: a slow consumer must never block a participant's save.
    void attempt(hook, deliveryId, JSON.stringify(payload));
  }
}

async function attempt(hook: WebhookRow, deliveryId: string, body: string, tryNo = 1): Promise<void> {
  const row = get<{ id: string }>(`SELECT id FROM webhook_deliveries WHERE delivery_id = ?`, deliveryId);
  if (!row) return;
  try {
    await assertSafeUrl(hook.url);   // re-checked per attempt: DNS can change
  } catch (err) {
    run(`UPDATE webhook_deliveries SET status = 'blocked', last_error = ?, completed_at = ? WHERE id = ?`,
      err instanceof Error ? err.message : "blocked", nowIso(), row.id);
    return;
  }

  const timestamp = nowIso();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(hook.url, {
      method: "POST",
      signal: controller.signal,
      redirect: "manual",            // a redirect could point back at a blocked host
      headers: {
        "Content-Type": "application/json",
        "X-Forgeboard-Delivery": deliveryId,
        "X-Forgeboard-Timestamp": timestamp,
        "X-Forgeboard-Signature": `sha256=${sign(hook.secret, deliveryId, timestamp, body)}`,
      },
      body,
    });
    clearTimeout(timer);
    if (res.ok) {
      run(`UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, completed_at = ? WHERE id = ?`,
        tryNo, nowIso(), row.id);
      run(`UPDATE webhooks SET last_status = ?, failures = 0 WHERE id = ?`, `${res.status}`, hook.id);
      return;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "delivery failed";
    run(`UPDATE webhook_deliveries SET attempts = ?, last_error = ? WHERE id = ?`, tryNo, message, row.id);
    run(`UPDATE webhooks SET last_status = ?, failures = failures + 1 WHERE id = ?`, message.slice(0, 80), hook.id);
    if (tryNo >= MAX_ATTEMPTS) {
      run(`UPDATE webhook_deliveries SET status = 'failed', completed_at = ? WHERE id = ?`, nowIso(), row.id);
      return;
    }
    const backoff = 1000 * 2 ** (tryNo - 1);   // 1s, 2s, 4s — bounded
    setTimeout(() => void attempt(hook, deliveryId, body, tryNo + 1), backoff);
  }
}
