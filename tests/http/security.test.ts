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

  test('sign-in does not redirect off-site', async () => {
    const client = new Client(server.url);
    const token = await client.csrfToken('/login');
    const reply = await client.request('POST', '/login?next=//evil.example/x', {
      body: new URLSearchParams({ _csrf: token, email: 'priya1@example.org', password: 'forgeboard-demo' }).toString(),
      type: 'application/x-www-form-urlencoded',
    });
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.get('location'), '/dashboard');
  });

  test('password guessing is rate limited', async () => {
    const client = new Client(server.url);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await client.signIn('organizer@forgeboard.local', `wrong-${i}`)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses.at(-1), 429);
  });

  test('an imported account without a password cannot be claimed by signing up', async () => {
    const reply = await new Client(server.url).postForm('/signup', { name: 'Not Tomas', email: 'tomas.varga@example.org', password: 'takeover123' }, { tokenFrom: '/signup' });
    assert.equal(reply.status, 422);
    assert.match(reply.text, /added by an organizer/);
  });

  test('user text is escaped wherever it is shown', async () => {
    const admin = new Client(server.url);
    await admin.signIn('admin@forgeboard.local');
    const future = new Date(Date.now() + 3600_000).toISOString().slice(0, 16);
    await admin.postForm('/events/new', { name: 'XSS <img src=x onerror=alert(1)>', submissions_close_at: future, tracks: '' });
    const page = await new Client(server.url).get('/events');
    assert.ok(page.text.includes('XSS &lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!page.text.includes('<img src=x'));
  });

  test('demo sessions exist only in demo mode', async () => {
    const production = await startServer({ demo: false });
    try {
      assert.equal((await new Client(production.url, DEMO_SESSIONS.organizer).get('/api/me')).status, 401);
      assert.ok(production.booted.setupLink, 'a first-admin setup link is issued instead');
      const setup = new URL(production.booted.setupLink ?? '');
      const client = new Client(production.url);
      assert.match((await client.get(setup.pathname)).text, /Set up your account/);
      assert.equal((await client.postForm(setup.pathname, { password: 'admin-password' }, { tokenFrom: setup.pathname })).status, 303);
      assert.equal((await client.get('/admin')).status, 200);
      assert.equal((await new Client(production.url).get(setup.pathname)).status, 410, 'the link works once');
    } finally {
      await production.close();
    }
  });
});
