import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { Client, FIXTURES, startServer } from '../helpers.ts';

/** T4 embeddable widget: framable, script-free, and never shows more than the public pages. */

const fixture = JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as { projects: { id: string; title: string; track: string }[]; judges: { name: string }[] };
const S = 'sample-hack-2026';
const DUPLICATE = 'prj_07';
const escaped = (title: string) => title.replace(/&/g, '&amp;').replace(/'/g, '&#39;');

describe('the embeddable widget (T4)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const anon = () => new Client(server.url);
  before(async () => {
    server = await startServer();
  });
  after(() => server.close());

  test('any site may frame it; the policy allows no script and no form', async () => {
    const reply = await anon().get(`/embed/${S}`);
    assert.equal(reply.status, 200);
    const csp = reply.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors \*/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.equal(reply.headers.get('x-frame-options'), null);
    assert.doesNotMatch(reply.text, /<script|<form/);
  });

  test('every other page still refuses to be framed', async () => {
    for (const url of ['/', '/projects', `/events/${S}`, `/events/${S}/results`, '/login']) {
      const reply = await anon().get(url);
      assert.equal(reply.headers.get('x-frame-options'), 'DENY', url);
      assert.match(reply.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, url);
    }
  });

  test('the gallery view lists every public project and not the superseded duplicate', async () => {
    const text = (await anon().get(`/embed/${S}`)).text;
    for (const p of fixture.projects.filter((p) => p.id !== DUPLICATE)) assert.ok(text.includes(`/projects/${p.id}"`), p.id);
    assert.ok(!text.includes(`/projects/${DUPLICATE}"`));
    assert.match(text, /40 projects/);
  });

  test('no judge names, scores or comments in the widget', async () => {
    const text = (await anon().get(`/embed/${S}`)).text;
    for (const judge of fixture.judges) assert.ok(!text.includes(judge.name), judge.name);
    assert.doesNotMatch(text, /jdg_\d\d|Runs clean\.|Docs are thin\./);
  });

  test('the track filter narrows it to that track', async () => {
    const text = (await anon().get(`/embed/${S}?track=trk_01`)).text;
    for (const p of fixture.projects.filter((p) => p.id !== DUPLICATE)) {
      assert.equal(text.includes(`/projects/${p.id}"`), p.track === 'trk_01', p.id);
    }
  });

  test('links open the public pages in a new tab, at the public URL', async () => {
    const text = (await anon().get(`/embed/${S}`)).text;
    assert.match(text, /href="http:\/\/[^"]+\/projects\/prj_01" target="_blank" rel="noopener"/);
  });

  test('the results view shows nothing before publication', async () => {
    const text = (await anon().get(`/embed/${S}?view=results`)).text;
    assert.match(text, /hidden until the organizers publish/);
    assert.doesNotMatch(text, /class="rank"/);
  });

  test('after publication the results view lists every ranked project in rank order', async () => {
    server.booted.store.run("UPDATE events SET submissions_close_at = '2000-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
    const organizer = Client.as(server.url, 'organizer');
    assert.equal((await organizer.request('POST', `/organize/${S}/results/publish`, { body: '{}', type: 'application/json', headers: { accept: 'application/json' } })).status, 200);
    const text = (await anon().get(`/embed/${S}?view=results`)).text;
    const ranks = [...text.matchAll(/<span class="rank">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    assert.equal(ranks.length, 40);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.ok(text.includes(escaped(fixture.projects[0]?.title ?? '')));
  });

  test('an unknown event is a 404', async () => {
    assert.equal((await anon().get('/embed/no-such-event')).status, 404);
  });

  test('the organizer gets the snippets on the export page', async () => {
    const text = (await Client.as(server.url, 'organizer').get(`/organize/${S}/export`)).text;
    assert.match(text, /&lt;iframe src=&quot;http:\/\/[^&]+\/embed\/sample-hack-2026&quot;/);
    assert.match(text, /\/embed\/sample-hack-2026\?view=results/);
  });
});
