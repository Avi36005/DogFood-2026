import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, startServer } from '../helpers.ts';

const C = '/judge/sample-hack-2026/compare';

/** Compare mode: judges choose between two of their own assigned projects. */
describe('compare mode (pairwise judging)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let judge: Client;
  let pair: [string, string];

  before(async () => {
    server = await startServer();
    judge = Client.as(server.url, 'judge_a');
  });
  after(() => server.close());

  test('a judge is shown two of their own assigned projects', async () => {
    const page = await judge.get(C);
    assert.equal(page.status, 200);
    const winners = [...page.text.matchAll(/name="winner" value="(prj_\d+)"/g)].map((m) => m[1] as string);
    assert.equal(winners.length, 2);
    pair = [winners[0] as string, winners[1] as string];
    const mine = server.booted.store.all<{ project_id: string }>("SELECT project_id FROM assignments WHERE event_id = 'evt_01' AND judge_id = 'jdg_24'").map((r) => r.project_id);
    for (const p of pair) assert.ok(mine.includes(p), `${p} is assigned to judge A`);
    assert.match((await judge.get('/judge/sample-hack-2026')).text, /Compare mode/);
  });

  test('a choice is recorded once, and is final', async () => {
    assert.equal((await judge.postForm(C, { winner: pair[0], loser: pair[1] }, { tokenFrom: C })).status, 303);
    assert.equal((await judge.postJson(C, { winner: pair[1], loser: pair[0] })).status, 409, 'the same pair, either way round');
    assert.throws(() => server.booted.store.run('DELETE FROM pairwise_votes'), /pairwise choices are final/);
    assert.match((await judge.get(C)).text, /1 of \d+ pairs compared/);
  });

  test('projects outside the judge’s assignments are refused and audited', async () => {
    const other = server.booted.store.get<{ project_id: string }>("SELECT project_id FROM assignments WHERE event_id = 'evt_01' AND judge_id = 'jdg_29' LIMIT 1")?.project_id as string;
    assert.equal((await judge.postJson(C, { winner: other, loser: pair[0] })).status, 403);
    const audit = (await Client.as(server.url, 'organizer').get('/organize/sample-hack-2026/audit?action=access.denied')).text;
    assert.match(audit, /compare projects not assigned to them/);
    assert.equal((await Client.as(server.url, 'participant').get(C)).status, 403);
    const anonymous = await new Client(server.url).get(C);
    assert.equal(anonymous.status, 303, 'signed-out visitors are sent to sign in');
    assert.match(anonymous.headers.get('location') ?? '', /\/login/);
  });

  test('the organizer sees the pairwise second opinion beside the rubric ranking', async () => {
    const results = (await Client.as(server.url, 'organizer').get('/organize/sample-hack-2026/results')).text;
    assert.match(results, /Second opinion: pairwise \(Bradley–Terry\)/);
    assert.match(results, /plus 1 made in compare mode/);
    assert.match(results, /ρ = 0\.\d\d/);
  });

  test('once judging closes, choices are refused', async () => {
    const org = Client.as(server.url, 'organizer');
    assert.equal((await org.postForm('/organize/sample-hack-2026/results/publish', {})).status, 303);
    const page = (await judge.get(C)).text;
    assert.match(page, /compare mode is read-only/);
    const [a, b] = [...page.matchAll(/(prj_\d+)/g)].map((m) => m[1] as string);
    assert.ok((await judge.postJson(C, { winner: a ?? pair[0], loser: b ?? pair[1] })).status >= 400);
  });
});
