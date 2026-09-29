import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { record } from '../../src/domain/audit.ts';
import { systemActor } from '../../src/domain/types.ts';
import { BACKOFF_SECONDS, deliverDue, MAX_ATTEMPTS, signatureHeader, verifySignatureHeader } from '../../src/domain/webhooks.ts';
import { Client, startServer } from '../helpers.ts';

/** T4 webhooks, delivered to a real HTTP receiver on this machine. */

interface Received { headers: http.IncomingHttpHeaders; body: string }

describe('webhooks (T4)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let receiver: http.Server;
  let hookUrl = '';
  let reply = 200;
  const received: Received[] = [];
  const S = 'sample-hack-2026';
  const organizer = () => Client.as(server.url, 'organizer');
  const json = (client: Client, url: string, body: unknown) => client.request('POST', url, { body: JSON.stringify(body), type: 'application/json', headers: { accept: 'application/json' } });
  const deliveries = (type?: string) => server.booted.store.all<{ id: string; type: string; status: string; attempts: number; audit_id: number | null; payload: string; next_attempt_at: string; last_error: string | null }>(`SELECT * FROM webhook_deliveries${type ? ' WHERE type = ?' : ''} ORDER BY created_at, id`, type ? [type] : []);
  let secret = '';
  let hookId = '';

  before(async () => {
    server = await startServer();
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(reply).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address();
    hookUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hooks/forgeboard`;
  });
  after(async () => {
    await server.close();
    await new Promise((resolve) => receiver.close(resolve));
  });

  describe('who may manage webhooks', () => {
    for (const [who, client, status] of [
      ['a visitor', () => new Client(server.url), 401],
      ['a participant', () => Client.as(server.url, 'participant'), 403],
      ['judge A', () => Client.as(server.url, 'judge_a'), 403],
    ] as [string, () => Client, number][]) {
      test(`${who} cannot add one (${status})`, async () => {
        assert.equal((await json(client(), `/organize/${S}/webhooks`, { url: hookUrl, events: ['results.published'] })).status, status);
      });
      test(`${who} cannot see the page`, async () => {
        const page = await client().get(`/organize/${S}/webhooks`);
        assert.equal(page.status, status === 401 ? 303 : 403);
        assert.doesNotMatch(page.text, /whsec_/);
      });
    }
  });

  describe('validation', () => {
    for (const [name, body, field] of [
      ['not an http(s) URL', { url: 'ftp://example.org/x', events: ['results.published'] }, 'url'],
      ['no URL', { events: ['results.published'] }, 'url'],
      ['no events', { url: hookUrl || 'http://127.0.0.1:9/x', events: [] }, 'events'],
      ['an unknown event', { url: 'http://127.0.0.1:9/x', events: ['judge.bribed'] }, 'events'],
    ] as [string, Record<string, unknown>, string][]) {
      test(`${name} is refused with a message on ${field}`, async () => {
        const reply = await json(organizer(), `/organize/${S}/webhooks`, body);
        assert.equal(reply.status, 422);
        assert.ok(reply.json<{ fields: Record<string, string> }>().fields[field]);
      });
    }
  });

  test('the organizer adds one and gets its signing secret back; it is audited', async () => {
    const reply = await json(organizer(), `/organize/${S}/webhooks`, { url: hookUrl, events: ['event.submissions_closed', 'results.published', 'review.submitted'] });
    assert.equal(reply.status, 201);
    const hook = reply.json<{ webhook: { id: string; secret: string; url: string } }>().webhook;
    assert.match(hook.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    secret = hook.secret;
    hookId = hook.id;
    assert.equal(server.booted.store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'webhook.created' AND subject_id = ?", [hook.id])?.n, 1);
  });

  test('a test ping arrives signed, and the signature checks out independently', async () => {
    assert.equal((await json(organizer(), `/organize/${S}/webhooks/${hookId}/ping`, {})).status, 200);
    const now = new Date();
    assert.equal(await deliverDue(server.booted.store, now), 1);
    const got = received.at(-1) as Received;
    assert.equal(got.headers['forgeboard-event'], 'webhook.ping');
    assert.equal(got.headers['content-type'], 'application/json');
    const header = got.headers['forgeboard-signature'] as string;
    const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
    assert.equal(v1, createHmac('sha256', secret).update(`${t}.${got.body}`).digest('hex'), 'HMAC-SHA256 over "<t>.<body>"');
    assert.equal(verifySignatureHeader(secret, got.body, header, Math.floor(now.getTime() / 1000)), true);
    assert.equal(JSON.parse(got.body).type, 'webhook.ping');
    assert.equal(deliveries('webhook.ping')[0]?.status, 'delivered');
  });

  test('a stale timestamp or the wrong secret fails verification', () => {
    const body = '{"x":1}';
    const header = signatureHeader(secret, body, 1_000_000);
    assert.equal(verifySignatureHeader(secret, body, header, 1_000_000 + 301), false, 'older than five minutes');
    assert.equal(verifySignatureHeader('whsec_other', body, header, 1_000_000), false);
    assert.equal(verifySignatureHeader(secret, `${body} `, header, 1_000_000), false, 'body changed');
  });

  test('closing submissions fires event.submissions_closed, tied to its audit entry by id and hash', async () => {
    const before = received.length;
    // The fixture event closed in March; reopen it so there is something to close.
    server.booted.store.run("UPDATE events SET submissions_close_at = '2099-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
    assert.equal((await json(organizer(), `/organize/${S}/close-submissions`, {})).status, 200);
    const queued = deliveries('event.submissions_closed');
    assert.equal(queued.length, 1);
    await deliverDue(server.booted.store, new Date());
    assert.equal(received.length, before + 1);
    const payload = JSON.parse(received.at(-1)?.body ?? '{}') as { type: string; event: { slug: string }; audit: { id: number; hash: string } };
    assert.equal(payload.type, 'event.submissions_closed');
    assert.equal(payload.event.slug, S);
    const entry = server.booted.store.get<{ hash: string; action: string }>('SELECT hash, action FROM audit_log WHERE id = ?', [payload.audit.id]);
    assert.equal(entry?.hash, payload.audit.hash);
    assert.equal(entry?.action, 'event.submissions_closed');
  });

  test('publishing results fires results.published', async () => {
    server.booted.store.run("UPDATE events SET submissions_close_at = '2000-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
    assert.equal((await json(organizer(), `/organize/${S}/results/publish`, {})).status, 200);
    await deliverDue(server.booted.store, new Date());
    assert.equal(JSON.parse(received.at(-1)?.body ?? '{}').type, 'results.published');
  });

  test('an event nobody subscribed to queues nothing', () => {
    const count = deliveries().length;
    record(server.booted.store, systemActor(), { eventId: 'evt_01', action: 'project.withdrawn', summary: 'not subscribed' });
    assert.equal(deliveries().length, count);
  });

  test('a change that rolls back never fires (the outbox shares its transaction)', () => {
    const count = deliveries().length;
    assert.throws(() =>
      server.booted.store.tx(() => {
        record(server.booted.store, systemActor(), { eventId: 'evt_01', action: 'results.published', summary: 'about to fail' });
        throw new Error('rolled back');
      }),
    );
    assert.equal(deliveries().length, count);
  });

  test("a review.submitted payload never carries the review's scores", () => {
    record(server.booted.store, systemActor(), { eventId: 'evt_01', action: 'review.submitted', subjectType: 'assignment', subjectId: 'asg_x', summary: 'A judge submitted a review.', detail: { functionality: 5, quality: 2 } });
    const payload = deliveries('review.submitted').at(-1)?.payload ?? '';
    assert.match(payload, /"subject":\{"type":"assignment","id":"asg_x"\}/);
    assert.doesNotMatch(payload, /functionality|quality|"detail"/);
  });

  test(`a failing receiver is retried with backoff (${BACKOFF_SECONDS} s doubling) and given up after ${MAX_ATTEMPTS} attempts`, async () => {
    const store = server.booted.store;
    store.run("UPDATE webhook_deliveries SET status = 'delivered', delivered_at = created_at WHERE status = 'pending'");
    reply = 500;
    record(store, systemActor(), { eventId: 'evt_01', action: 'results.published', summary: 'retry me' });
    const id = deliveries('results.published').at(-1)?.id as string;
    let now = new Date();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      assert.equal(await deliverDue(store, now), 1, `attempt ${attempt} is due`);
      const d = store.get<{ status: string; attempts: number; next_attempt_at: string; last_error: string }>('SELECT status, attempts, next_attempt_at, last_error FROM webhook_deliveries WHERE id = ?', [id]);
      assert.equal(d?.attempts, attempt);
      assert.equal(d?.last_error, 'HTTP 500');
      if (attempt < MAX_ATTEMPTS) {
        assert.equal(d?.status, 'pending');
        const wait = new Date(d?.next_attempt_at as string).getTime() - now.getTime();
        assert.equal(wait, BACKOFF_SECONDS * 1000 * 2 ** (attempt - 1));
        assert.equal(await deliverDue(store, new Date(now.getTime() + wait - 1000)), 0, 'not before its time');
        now = new Date(now.getTime() + wait);
      } else {
        assert.equal(d?.status, 'failed');
      }
    }
    reply = 200;
  });

  test('an unreachable receiver is an error to retry, not a crash', async () => {
    const store = server.booted.store;
    const hook = (await json(organizer(), `/organize/${S}/webhooks`, { url: 'http://127.0.0.1:9/nobody', events: ['vote.published'] })).json<{ webhook: { id: string } }>().webhook;
    record(store, systemActor(), { eventId: 'evt_01', action: 'vote.published', summary: 'to nowhere' });
    await deliverDue(store, new Date());
    const d = store.get<{ status: string; attempts: number; last_error: string | null }>("SELECT status, attempts, last_error FROM webhook_deliveries WHERE type = 'vote.published' AND webhook_id = ?", [hook.id]);
    assert.equal(d?.status, 'pending');
    assert.equal(d?.attempts, 1);
    assert.ok(d?.last_error);
  });

  test('removing a webhook stops its pending deliveries and is audited', async () => {
    const store = server.booted.store;
    record(store, systemActor(), { eventId: 'evt_01', action: 'results.published', summary: 'after removal' });
    assert.equal((await json(organizer(), `/organize/${S}/webhooks/${hookId}/remove`, {})).status, 200);
    const before = received.length;
    await deliverDue(store, new Date(Date.now() + 3_600_000));
    assert.equal(received.length, before, 'nothing sent to a removed webhook');
    assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'", [hookId])?.n, 0);
    assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'webhook.removed' AND subject_id = ?", [hookId])?.n, 1);
  });

  test('the organizer page shows each webhook, its secret and the delivery log', async () => {
    const page = await organizer().get(`/organize/${S}/webhooks`);
    assert.equal(page.status, 200);
    assert.match(page.text, /127\.0\.0\.1:9\/nobody/);
    assert.match(page.text, /whsec_/);
    assert.match(page.text, /delivered/);
    assert.match(page.text, /failed/);
  });

  test('an administrator may manage them too (FIG. 02), with an audit entry', async () => {
    const { createSession } = await import('../../src/domain/sessions.ts');
    const admin = new Client(server.url, createSession(server.booted.store, 'usr_demo_admin', new Date()));
    assert.equal((await admin.get(`/organize/${S}/webhooks`)).status, 200);
    assert.ok((server.booted.store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'admin.access' AND summary LIKE '%webhooks%'")?.n ?? 0) >= 1);
  });
});
