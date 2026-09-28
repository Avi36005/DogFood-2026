import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, DEMO_SESSIONS, startServer } from '../helpers.ts';

describe('web security', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  test('a form post without the CSRF token is refused', async () => {
    const reply = await Client.as(server.url, 'organizer').postForm('/organize/sample-hack-2026/assignments/auto', {}, { csrf: false });
    assert.equal(reply.status, 403);
    assert.match(reply.text, /form has expired/);
  });

  test('a post from another origin is refused even with a valid token', async () => {
    const client = Client.as(server.url, 'organizer');
    const token = await client.csrfToken();
    const reply = await client.request('POST', '/organize/sample-hack-2026/assignments/auto', {
      body: `_csrf=${encodeURIComponent(token)}`,
      type: 'application/x-www-form-urlencoded',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(reply.status, 403);
    assert.match(reply.text, /another site/);
  });

  test('a text/plain body (what a cross-site form can send) is not treated as JSON', async () => {
    const reply = await Client.as(server.url, 'organizer').request('POST', '/organize/sample-hack-2026/results/publish', { body: '{}', type: 'text/plain' });
    assert.equal(reply.status, 415, 'refused as an unsupported format before any handler runs');
    assert.equal(server.booted.store.get<{ p: string | null }>("SELECT results_published_at AS p FROM events WHERE id = 'evt_01'")?.p, null);
  });

  test('pages carry a strict content security policy and anti-framing headers', async () => {
    const { headers } = await new Client(server.url).get('/');
    assert.match(headers.get('content-security-policy') ?? '', /script-src 'self'; style-src 'self'/);
    assert.match(headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('cache-control'), 'no-store');
  });

  test('the session cookie is HttpOnly and SameSite, and signing out ends the session', async () => {
    const client = new Client(server.url);
    const signIn = await client.signIn('priya1@example.org');
    const cookie = signIn.headers.getSetCookie().find((c) => c.startsWith('session='));
    assert.match(cookie ?? '', /HttpOnly/);
    assert.match(cookie ?? '', /SameSite=Lax/);
    const token = client.cookies.get('session') ?? '';
    assert.equal((await client.get('/api/me')).status, 200);
    await client.postForm('/logout', {});
    assert.equal((await new Client(server.url, token).get('/api/me')).status, 401, 'the old token is dead');
  });
});
